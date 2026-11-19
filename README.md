# dsh-session-firstpaint

冷会话首屏只解压日志尾部若干 zstd 帧就交出快照，完整读取转到后台。

## 解决什么

冷会话第一次打开时，`SessionController.follow` 必须先 `observeSession(sessionId)`，
而那一步要把**整份日志**解压、逐行 `JSON.parse`、深度冻结、重建 `Session`、再跑一遍投影 fold，
之后才轮得到 `paginate` 分页。实测：

| 会话 | 日志 | 解压后 | 事件 | 全量耗时 |
|---|---|---|---|---|
| 会话 B | 54.0 MB | 175.7 MB | 63234 | 解压 3.6 s + 解析 2.4 s + 冻结 0.24 s |
| 会话 C | 36.1 MB | 129.6 MB | 44380 | 解压 2.3 s + 解析 1.8 s |

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

没有预热、没有额外后台任务、不缓存任何跨请求状态。

## 解码缓存扩容（memo-budget）

首屏快路径解决的是「多久能看到内容」，但**「多久能开始干活」**取决于宿主的完整解码，
那一步仍然要 2~4 秒。而宿主把解码结果缓存在 `coldLogMemo` 里，容量写死为
`COLD_LOG_MEMO_MAX_ENTRIES = 2`——两个位置，用户在第三个长会话上一跳，
第一个就被挤掉，切回来又要重新解码。

实测（2026-11-20，本机）：

| 场景 | 宿主原样（2 条） | 扩容后（1500 MB） |
|---|---|---|
| A→B→C→D→E 依次首开 | 4374 / 3555 / 2687 / 2560 / 2267 ms | 4748 / 5851 / 3830 / 3163 / 3253 ms |
| 再依次开第二遍 | A 7ms、B **3329ms**、C **2687ms** 被挤出 | A 9 / B 7 / C 8 / D 7 / E 7 ms |
| 命中率 | 2/5 | **5/5** |

CPU profile（开 4 个最大会话，采样 19219 ms）说明命中的时候省掉了什么：

```
consumeEventLine   7726ms  40.2%     解压帧       2957ms  15.4%
GC                 1464ms   7.6%     深冻结       1144ms   6.0%
utf8Slice          1049ms   5.5%     v4 行校验     243ms   1.3%
```

每条的驻留堆约 4.6 KB/事件（实测 `heapUsed` 差值：61.4 MB/78557 事件 → +357 MB）。

实现只替换 `memoizeStoredLog` 的淘汰策略，字节预算 + LRU；不改事件内容、不做额外校验，
也不改变 `revision` 比对——文件一变宿主照旧不复用。堆压力兜底：插入后若 `heapUsed`
超过高水位（默认 3000 MB）立即回收到半预算。

配置：`memoBudgetMb`（默认 1500）、`memoHeapHighWaterMb`（默认 3000）。

## 命中条件

只有**同时满足**才走快路径，否则完全透传原实现：

- 地址是普通会话（`kind: 'session'`），子代理地址不拦截；
- `ctx.sessions.get(id) === undefined`，即会话尚未 attach；
- `sessionPersistence.stat(id)` 有当前格式代的 `.jsonl.zstd` 产物；
- 尾部解析得到**连续**且 seq 合法的窗口（任何一步不符就退回）。

## 首屏契约（已逐条核对客户端代码）

| 客户端要求 | 出处 | 满足方式 |
|---|---|---|
| 末条记录 seq 必须等于 opening cursor | `journal-stream.ts` `assertPageThrough` | cursor 取真实尾部 seq |
| `assistantStream` 必须存在 | `transport.ts` 缺则抛错 | 给 `{ revision: 0 }`（冷会话无活跃尝试） |
| `projections` 可缺 | `session.ts` 对 `undefined` 有分支 | **省略字段**，而非空 baseline |
| 记录必须连续 | `assertPage` | 尾部窗口天然连续，且已校验 seq 连续 |

不给 `projections` 是刻意的：`ProjectionValueStore.seed()` 会按 `asOfSeq` 清掉更晚的行，
给空 baseline 反而会把列表阶段已到达的投影值抹掉。

## 首屏裁剪

窗口里有几类字段对首屏渲染无用，删掉不影响任何显示：

| 字段 | 为什么能删 |
|---|---|
| `assistant/message.data.stream` | 客户端只有 trajectory 取 `firstTokenTime`；置 `[]` 后该函数返回 `undefined`，调用处有 `??` 兜底 |
| `request/header.data.header.tools` | 只在「请求详情」面板用；消费方写的是 `Array.isArray(rawTools) ? rawTools : []` |
| `job/registered` / `job/settled` 的 `label` | 是工具命令原文，同一轮的 `tool/call.arguments` 已逐字带着它 |
| 同上 `owner` | 恒等于本会话 id，由 header 即可推出 |

`job/*` 事件在客户端**没有任何渲染节点**：全仓库 19 个引用它的文件里，只有
`dsh-api-session-controller` 的已知类型白名单提到这两个类型，`dsh-client-ui-chat`
的 13 个节点定义里一个都没有。

实测 8 个最大会话（每个 20 条消息的尾部窗口）：

| 会话（压缩后大小） | 事件 | 原始 | 裁剪后 | 压缩率 |
|---|---|---|---|---|
| 会话 A（61.4 MB） | 159 | 261 KB | 129 KB | 49.4% |
| 会话 B（57.9 MB） | 120 | 380 KB | 137 KB | 36.1% |
| 会话 C（43.8 MB） | 132 | 206 KB | 108 KB | 52.4% |
| 会话 D（41.0 MB） | 116 | 396 KB | 181 KB | 45.7% |
| 会话 E（28.8 MB） | 77 | 114 KB | 68 KB | 59.6% |
| 会话 F（25.2 MB） | 163 | 429 KB | 331 KB | 77.2% |
| 会话 G（22.3 MB） | 111 | 308 KB | 88 KB | 28.6% |
| 会话 H（20.0 MB） | 104 | 127 KB | 63 KB | 49.6% |
| **合计** | — | **2221 KB** | **1105 KB** | **50.2%** |

其中 `job.label` 单独贡献：6 个大会话合计 75 KB / 950 KB（7.9%）。

裁剪生效性验证（103 个 job 事件 + 89 个 tool/result + 90 个 tool/call）：

| 检查 | 结果 |
|---|---|
| `job.label` 残留 | 0 |
| `job.owner` 残留 | 0 |
| `tool/result.content` 保留 | 89 / 89 |
| `tool/call.arguments` 保留 | 89 / 90（1 个本身是空串） |
| `tool/ptc-dispatch.arguments` 保留 | 43 / 43 |

### 折叠详情为什么不能裁

工具调用在首屏是**折叠行**，但折叠行本身要显示内容，而那内容就是从这些字段算出来的。
`dsh-client-ui-tool` 的摘要函数：

```js
function deriveSummary(variant, argsRaw) {
  const parsed = parseArgs(argsRaw)                 // JSON.parse(call.argsRaw)
  if (variant === 'search' && Array.isArray(args.queries)) ...
  const picked = pickString(args, SUMMARY_KEYS[variant])
  if (picked !== undefined) return firstLine(picked)
  for (const v of Object.values(args)) if (typeof v === 'string' && v !== '') return firstLine(v)
  return firstLine(argsRaw)                        // 兜底也读原文
}
```

`tool/result` 同理由 `block.content` 取折叠行右侧的摘要。所以裁掉它们不是"少加载了
用不到的东西"，而是把折叠行变成空白。

更关键的是**没有第二份副本可以补**：本插件为了省掉重复解码，把宿主那份完整 opening
丢弃了（见上文第 3 步），尾部窗口就是客户端拿到的唯一数据。裁了之后展开工具卡片
永远是空的，滚动到那一屏也不会自愈。

### 试过但放弃的两个优化

| 想法 | 为什么放弃 |
|---|---|
| `arguments` 字符串池化（`tool/call` 与 `assistant/message` 内嵌的那份逐字相同，实测 67 个调用 0 处不同） | 只省内存驻留，不省快照字节：序列化时两处都要展开成完整字符串，客户端收到的一样多。而快照本来只有 100~300 KB |
| 只保留摘要所需键 | 实测 114 个 `tool/call` 的 `arguments` 共 141 KB，只留摘要键仍要 139 KB（省 1.6%）——摘要的兜底逻辑会退回读原文 |

## 热开窗口与滑动加载

原实现的热开用固定参数 `maxMessages: 500` + `turnWindow: { minMessages: 50, minTurns: 2 }`。

**膨胀的主因是 `minTurns: 2`**，不是 500：它要求「至少凑满两整轮」，
而大会话单轮就有 300+ 事件，所以 500 这个硬预算根本没机会生效。
实测把 maxMessages 从 500 降到 60 几乎没用：

| 会话 | 500/2轮 | 500/1轮 | 60/无turn窗 |
|---|---|---|---|
| 会话 B | 327 事件 / 1.31 MB | 327 / 1.31 | 345 / 1.37 |
| 会话 A | 749 事件 / 1.68 MB | 749 / 1.68 | **430 / 0.90** |
| 会话 C | 637 事件 / 1.20 MB | 630 / 1.18 | **355 / 0.66** |

所以插件对**热开**也接管：去掉 `turnWindow`、把 `maxMessages` 收到上限。
配合上面的首屏裁剪，最终体积：

| 会话 | 改前 | 改后（cap=100 + 裁剪） |
|---|---|---|
| 会话 B | 1.31 MB | **0.91 MB** |
| 会话 A | 1.68 MB | **0.83 MB** |
| 会话 C | 1.20 MB | **0.60 MB** |

`hasMore` 仍由 `paginate` 如实返回，客户端滚到顶部照常触发 `loadOlder`
往前补一页——这就是滑动窗口，不需要改客户端。

## 消除全量深拷贝（shared load）

一次性采样（`stopCost` 仅 102 ms）抓到的最大热点不是磁盘、不是解压，而是：

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
命中/退回次数每 60 秒输出一次 `FASTLOAD hits=N coldFallback=M`。

## 已知限制

- **投影值要等完整读取跑完才到**（`todos` / `plan` / `inbox` / `goal` 等 key 会短暂读 `undefined`）；
- 窗口起点不做 `turn/start` 对齐（冷热一致），可能从一轮对话中间开始显示，
  往上滚一屏即自动补齐；
- 原实现的全量读取仍会发生（省的是**首屏等待**与尾部读的 I/O，不是总 I/O）。

## 诊断埋点

插件装了三组只读埋点，用来定位「打开慢 / 点击卡」，都写进
`$DSH_HOME/session-firstpaint.log`（内存缓冲 + 250 ms 批量落盘，不在关键路径做同步 I/O）。

| 埋点 | 输出行 | 回答什么问题 |
|---|---|---|
| 冷开首屏 | `BEGIN` / `HIT` / `EMIT` / `OPENING` | 首屏到底花了多久、读了多少字节 |
| 热开窗口 | `WARM` / `WARM-OPEN` | 窗口是否被收窄、热开首帧多快 |
| 主线程卡顿 | `LAG` | 卡了多久、卡在冷开后的第几毫秒 |
| 冷读分段 | `PROFILE` | 读文件 / 解压+parse / 校验+冻结 各占多少 |
| GC 归因 | `GCS` | 卡顿是不是垃圾回收造成的 |

`PROFILE` 用替换 `readStoredLog` / `decodeStoredLog` / `readZstdPrefix`
三个 prototype 方法实现，靠相减得到中间各段耗时，不需要读任何内部实现：

```
read            = total − decode
validate+freeze = decode − unzip+parse
```

`GCS` 行的 `topGc` 给出最慢的几次 GC（时刻:类型:耗时），
`topStall` 给出最长的几次主线程阻塞。两者时间轴对齐就能判断卡顿归属。

阈值默认 200 ms（`PROFILE`）/ 300 ms，可通过配置调整。

## 配置

```yaml
- id: session-firstpaint
  name: dsh-session-firstpaint
  config:
    # 冷开与热开共用的消息上限
    maxMessages: 20
    # 解码缓存字节预算与堆压力高水位（见「解码缓存扩容」）
    memoBudgetMb: 1500
    memoHeapHighWaterMb: 3000
    # 翻历史页：只计时不改包（改写会与客户端的锚点策略冲突，见下）
    historyPageEvents: 300
    historyRewrite: false
    # 首屏预缓存：目标消息数、内存上限、启动后延迟
    prefetchMessages: 5
    prefetchBudgetKb: 4096
    prefetchDelayMs: 30000
    # 诊断阈值
    profileThresholdMs: 200
    stallThresholdMs: 120
    gcThresholdMs: 150
    # 一次性 CPU 采样（默认关闭）
    sample: false
    sampleWindowMs: 60000
    sampleIntervalUs: 10000
```

## 翻历史为什么不改写回包

早期版本会对 `loadOlder` 那一页做两处改写：把 `turnWindow.minTurns` 收到 1，
并在页超过 `historyPageEvents` 时从尾部收紧到最近的 `turn/start`。

这在**用户正在滚动**的场景会跳页。客户端的 `ChatViewport.historyConsumption()`：

```js
if (this.historyScrolling.size === 0) return scroller.scrollTop <= .5 ? 'prepend' : 'preserve'
...
return scroller.scrollTop <= .5 ? 'prepend' : 'native'      // 用户正在滚 + overflow-anchor 可用
```

`native` 分支**不做任何锚点补偿**，完全交给浏览器 `overflow-anchor`；而同一文件的
`createFlowMotion` 在滚动动效激活时会把 `overflowAnchor` 置成 `none`：

```js
createFlowMotion(..., active => {
  if (this.elements !== null) this.elements.scroller.style.overflowAnchor = active ? 'none' : ''
})
```

两者叠加时，改回包事件条数就没有任何东西维持视觉位置，表现为上翻跳页。
所以 `historyRewrite` 默认 `false`，只保留 `HISTORY-COST`（每页耗时/体积）与
`HISTORY-PAGE`（收窄统计）两组计时。

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

`memo-budget` 的定位也做了同样的防御：它不按名字静态猜原型链，而是以
`open` 所在的原型为主锚点（`profile.js` 用同一条路径稳定命中），依次尝试
`open` 原型 → 其上层 → 全链 → 实例自身，并在失败时把整条原型链写进日志
（`MEMOBUDGET-SKIP ... chain=...`），下一版不用再猜。命中时日志会带 `via=open-proto`。

## 自测

```sh
node test.mjs
```

八个用例覆盖：冷会话命中、已 attach 透传、无产物退回、还原后原型恢复、
子代理地址不拦截、配置传入 + 首屏裁剪字段、冷开记录不被热开覆盖、
热开窗口收敛到上限。
测试用 `node:zlib` 现场造带 checksum 的同格式日志，不读写任何真实会话。

## 实测数据

| 会话 | 文件 | 尾部读字节 | 首屏事件 | 耗时 |
|---|---|---|---|---|
| 会话 B | 55.0 MB | **4.00 MB** | 295 | 131 ms |
| 会话 A | 61.4 MB | **4.00 MB** | 345 | 67 ms |
| 会话 C | 37.2 MB | **4.00 MB** | 334 | 84 ms |
| 会话 D | 31.7 MB | **4.00 MB** | — | 86 ms |
| 会话 E | 27.4 MB | **4.00 MB** | — | 97 ms |

合计磁盘读 **20.0 MB vs 整份读 212.6 MB，省 91%**。

线上首屏（诊断日志实测）：`firstpaint=114–120 ms`（对照：完整读取约 4–6 s）。

