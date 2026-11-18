# dsh-session-firstpaint

冷会话首屏只解压日志尾部若干 zstd 帧就交出快照，完整读取转到后台。

## 解决什么

冷会话第一次打开时，`SessionController.follow` 必须先 `observeSession(sessionId)`，
而那一步要把**整份日志**解压、逐行 `JSON.parse`、深度冻结、重建 `Session`、再跑一遍投影 fold，
之后才轮得到 `paginate` 分页。实测：

| 会话 | 日志 | 解压后 | 事件 | 全量耗时 |
|---|---|---|---|---|
| 54 MB 级 | 54.0 MB | 175.7 MB | 63234 | 解压 3.6 s + 解析 2.4 s + 冻结 0.24 s |
| 36 MB 级 | 36.1 MB | 129.6 MB | 44380 | 解压 2.3 s + 解析 1.8 s |

这段时间里主线程被连续同步工作占住，所以首屏要等好几秒，**发送和终止按钮也一起点不动**。

## 怎么做

zstd 帧是独立可解码的（带 checksum），而帧边界只需纯结构扫描就能定位（54 MB 约 94 ms）。
于是从文件尾部往前逐帧解压，凑够若干条消息就停——首屏只需要最近几轮对话。

插件在启动时替换 `SessionController.prototype.follow`：

1. 先把原实现的迭代器启动起来。它在函数体第一个 `await` 之前就建好了 `EventListener`，
   所以从这一刻起产生的事件都进它的缓冲队列，不会在出首屏的空窗里丢失；
2. **只读文件最后 4 MB**（不足则往前扩 4 倍重试），从尾部往前逐帧解压，
   凑够若干条消息就停；首帧的完整性由结构扫描验证，切在半帧上会自动跳过；
3. 丢弃原实现那份等价 opening（同一个尾部 cursor），只转发它排队中的增量事件。

## 命中条件

只有**同时满足**才走快路径，否则完全透传原实现：

- 地址是普通会话（`kind: 'session'`），子代理地址不拦截；
- `ctx.sessions.get(id) === undefined`，即会话尚未 attach；
- `sessionPersistence.stat(id)` 有当前格式代的 `.jsonl.zstd` 产物；
- 尾部解析得到**连续**且 seq 合法的窗口（任何一步不符就退回）。

## 首屏契约

| 客户端要求 | 出处 | 满足方式 |
|---|---|---|
| 末条记录 seq 必须等于 opening cursor | `journal-stream.ts` `assertPageThrough` | cursor 取真实尾部 seq |
| `assistantStream` 必须存在 | `transport.ts` 缺则抛错 | 给 `{ revision: 0 }`（冷会话无活跃尝试） |
| `projections` 可缺 | `session.ts` 对 `undefined` 有分支 | **省略字段**，而非空 baseline |
| 记录必须连续 | `assertPage` | 尾部窗口天然连续，且已校验 seq 连续 |

不给 `projections` 是刻意的：`ProjectionValueStore.seed()` 会按 `asOfSeq` 清掉更晚的行，
给空 baseline 反而会把列表阶段已到达的投影值抹掉。

## 首屏裁剪

窗口里两个字段对首屏渲染无用，实测占 65% 体积：

| 字段 | 占比 | 为什么能删 |
|---|---|---|
| `assistant/message.data.stream` | 37% | 客户端只有 trajectory 取 `firstTokenTime`；置 `[]` 后该函数返回 `undefined`，调用处有 `??` 兜底 |
| `request/header.data.header.tools` | 29% | 只在「请求详情」面板用；消费方写的是 `Array.isArray(rawTools) ? rawTools : []` |

`tool/call` 参数和 `tool/result` 正文**全部保留**——那些是展开后才看、丢了无法复原的内容。

## 窗口按消息边界截断

**这是个容易踩的坑**：`collectWindow` 从尾部往前逐帧收集，凑够 `maxMessages` 就 `break`。
但对**小于初始窗口（4 MB）的文件**，第一次读就把整份日志读进了缓冲区，
之后只解一帧就满足条件退出——如果直接返回 `collected` 全部内容，
`maxMessages` 参数就完全没生效。

实测一个 3.1 MB / 4292 事件的会话，`n=1/2/3` 都返回 4292 个事件、7.4 MB payload。
修复后在尾部按消息边界 `slice`，同样的会话降到 **19 KB**（缩小 385 倍）。

## 热开窗口与滑动加载

原实现的热开用固定参数 `maxMessages: 500` + `turnWindow: { minMessages: 50, minTurns: 2 }`。

**膨胀的主因是 `minTurns: 2`**，不是 500：它要求「至少凑满两整轮」，
而大会话单轮就有 300+ 事件，所以 500 这个硬预算根本没机会生效。
实测把 maxMessages 从 500 降到 60 几乎没用。

所以插件对**热开**也接管：去掉 `turnWindow`、把 `maxMessages` 收到上限。
配合上面的首屏裁剪，最终体积降到原本的 35~50%。

`hasMore` 仍由 `paginate` 如实返回，客户端滚到顶部照常触发 `loadOlder`
往前补一页——这就是滑动窗口，不需要改客户端。

## 消除全量深拷贝（shared load）

一次性 CPU 采样（`stopCost` 仅 102 ms）抓到的最大热点不是磁盘、不是解压，而是：

```
structuredClone @ node:internal/worker/js_transferable:25267ms
(garbage collector):9528ms
walkJsonValue @ dsh-util-values/lib/index.js:4754ms
deepFreeze @ dsh-util-values/lib/index.js:3912ms
```

来源是 `dsh-session-query` 的 `snapshotLive()`：

```js
events: session.snapshotEvents().map((event) => structuredClone(event))
```

它把整份日志的每个事件深拷贝一遍。真实 33 MB / 43950 事件会话实测：

| 做法 | 耗时 | 堆 |
|---|---|---|
| `structuredClone` 全部事件 | **1441～2243 ms** | **+418 MB** |
| 共享同一批引用 | **2 ms** | +0 |

**这些对象本来就是不可变的**，四条路径都做了 `deepFreeze`：

| 路径 | 位置 | 证据 |
|---|---|---|
| 落盘读取 | `freezeStoredEvents()` | 标 `eventState: 'shared-frozen'` |
| 实时追加 | `createAppendEvent()` | `deepFreeze({ type, seq, time, data, ...surface })` |
| Session 构造 | `constructor` seed 分支 | `this.log.push(deepFreeze(snapshot))` |
| header | `validateSessionHeader()` | `return deepFreeze(record)` |

`lib/fast-load.js` 替换 `SessionCorpus.prototype.load`：
只有**全部事件与 header 都已冻结**时才共享引用，任何一个没冻结就原样退回原实现。

`lib/query-fast.js` 再做三件相关的事：

- `readSession` 里那次结果被直接丢弃的 `Session.create`（实测 3087 ms）去掉；
- `readSession` 的事件映射改为逐事件判断：已冻结共享、未冻结走 `snapshotSessionEvent`
  （实测省 2529 ms，`cloned=0`）；
- `persistence.list` 加 15 秒 TTL 缓存（扫约 1000 个会话单次 800 ms~19 s），
  先 `throwIfAborted` 再查缓存，取消语义不变。

## 首屏预缓存

冷开时 `stat` 之后还要读文件尾部（实测 `read=100~1004 ms`）。
那部分只依赖文件内容，可以在空闲时先算好。

范围：**只排除 `origin: 'subagent'`**，不排除 `parentSession`——
带 `parentSession` 且 `isSeeded: true` 的是 **fork 出来的会话**，
它会出现在侧栏、能被点开，是正常会话。

实测 836 个会话里 730 个是 subagent，剩下 106 个中 35 个未归档，
预热这 35 个**总占用 430 KB**、单条平均构建 21 ms。

`lib/prefetch.js` 要点：

| 项 | 做法 |
|---|---|
| 缓存键 | `size:mtime:ino`，文件一变立刻作废 |
| 单条上限 | 256 KB，超大条目跳过（避免一条挤掉全部预算） |
| 内存预算 | 4 MB，超出按 LRU 淘汰 |
| 延迟 | 启动后 30 秒开始，避开高峰 |
| 让出 | 每处理 1 个会话 `await` 一次 |

命中后首屏降到 **17~18 ms**（只剩 `stat` 的 16 ms）。

## 已知限制

- **投影值要等完整读取跑完才到**（`todos` / `plan` / `inbox` / `goal` 等 key 会短暂读 `undefined`）；
- 窗口起点不做 `turn/start` 对齐（冷热一致），可能从一轮对话中间开始显示，
  往上滚一屏即自动补齐；
- 原实现的全量读取仍会发生（省的是**首屏等待**与尾部读的 I/O，不是总 I/O）；
- 完整解码（解压 + parse + 校验）插件碰不到：`readZstdPrefix` 依赖
  `createZstdFrameDecoder` / `SessionLogScanner` / `assertZstdHeaderFrame` 三个模块私有实现。

## 诊断埋点

所有埋点只读，写进 `$DSH_HOME/session-firstpaint.log`
（内存缓冲 + 250 ms 批量落盘，不在关键路径做同步 I/O）。

| 埋点 | 输出行 | 回答什么问题 |
|---|---|---|
| 冷开首屏 | `BEGIN` / `HIT` / `HIT-CACHED` / `EMIT` / `OPENING` | 首屏花了多久、读了多少字节、缓存是否命中 |
| 热开窗口 | `WARM` / `WARM-OPEN` | 窗口是否被收窄、热开首帧多快 |
| 主线程卡顿 | `STALL` / `GC` | 卡了多久、是不是 GC 造成的 |
| 冷读分段 | `PROFILE-OPEN` / `PROFILE-READ` | 解码 / 读文件 / 校验各占多少 |
| 查询层 | `READSESSION` / `LIST-SESSIONS` / `QUERY` | 谁在反复读会话、列表扫了多少 |
| 预缓存 | `PREFETCH begin/done` | 预热目标数、成功数、占用 |

## 配置

```yaml
- id: session-firstpaint
  name: dsh-session-firstpaint
  config:
    maxMessages: 100          # 冷开与热开共用的消息上限，默认 50
    prefetchMessages: 2       # 每条预缓存快照保留的消息数，默认 2
    prefetchBudgetKb: 4096    # 预缓存内存上限，默认 4096 KB
    prefetchDelayMs: 30000    # 启动后延迟多久预热，默认 30 秒
    profileThresholdMs: 200   # 冷读超过多少毫秒才记 PROFILE，默认 200
```

## 停用与还原

临时停用（不卸载）：profile 的 `cordis.patch.yml` 加

```yaml
- id: session-firstpaint
  disabled: true
```

插件卸载时 `ctx.effect` 的还原函数把 `prototype.follow` 换回原方法。
`prototype` 是共享的，而 HMR 下旧 fiber 的 cleanup 可能晚于新 fiber 的 apply，
所以 `PATCHED` 存的是**还原函数本身**：新装载先调用它摘掉旧包装，
还原时还会核对 `proto.follow` 是否仍是自己装的那个，避免迟到的 cleanup 摘掉新补丁。

## 自测

```sh
node test.mjs
```

八个用例覆盖：冷会话命中、已 attach 透传、无产物退回、还原后原型恢复、
子代理地址不拦截、配置传入 + 首屏裁剪字段、冷开记录、热开窗口收窄。
测试用 `node:zlib` 现场造带 checksum 的同格式日志，不读写任何真实会话。

## 实测数据

| 会话大小 | 文件 | 尾部读字节 | 首屏事件 | 耗时 |
|---|---|---|---|---|
| 55 MB 级 | 55.0 MB | **4.00 MB** | 295 | 131 ms |
| 61 MB 级 | 61.4 MB | **4.00 MB** | 345 | 67 ms |
| 37 MB 级 | 37.2 MB | **4.00 MB** | 334 | 84 ms |
| 31 MB 级 | 31.7 MB | **4.00 MB** | — | 86 ms |
| 27 MB 级 | 27.4 MB | **4.00 MB** | — | 97 ms |

合计磁盘读 **20.0 MB vs 整份读 212.6 MB，省 91%**。

线上首屏（诊断日志实测）：`firstpaint=114–120 ms`（对照：完整读取约 4–6 s）。
加预缓存后：`HIT-CACHED stat=16ms total=16ms`，即 **17~18 ms**。
