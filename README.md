# dsh-session-firstpaint

冷会话首屏只解压日志尾部若干 zstd 帧就交出快照，完整读取转到后台。

## 问题

冷会话第一次打开时，`SessionController.follow` 先执行 `observeSession(sessionId)`：解压整份日志、逐行 `JSON.parse`、深度冻结、重建 `Session`、跑一遍投影 fold，之后才轮到 `paginate` 分页。

这段时间主线程被同步工作占住，首屏要等数秒，发送和终止按钮同时点不动。

## 利用 zstd 帧独立解码解决首屏等待

zstd 帧带 checksum、可独立解码，帧边界能用纯结构扫描定位。插件替换 `SessionController.prototype.follow`：

1. 先启动原实现的迭代器。它在第一个 `await` 之前就建好 `EventListener`，此后产生的事件进它的缓冲队列；
2. 只读文件最后 4 MB（不足则往前扩 4 倍），从尾部往前逐帧解压，凑够消息数即停；首帧完整性由结构扫描验证；
3. 丢弃原实现那份等价 opening（同一尾部 cursor），只转发它排队中的增量事件。

无预热、无后台任务、不缓存跨请求状态。

## 利用字节预算 LRU 解决会话切换重复解码

宿主把解码结果缓存在 `coldLogMemo`，容量为 `COLD_LOG_MEMO_MAX_ENTRIES = 2`。两个位置在三个以上长会话间切换时互相挤出，切回来重新解码。

`lib/memo-budget.js` 只替换淘汰策略：字节预算 + LRU（默认 1500 MB）。缓存值仍是宿主自己的冻结对象，驱逐只丢引用，`revision` 比对不动。插入后 `heapUsed` 超过高水位（默认 3000 MB）时回收到半预算。

## 利用已冻结对象解决全量深拷贝

`dsh-session-query` 的 `snapshotLive()` 对每个事件做 `structuredClone`。事件本身不可变，四条路径都做过 `deepFreeze`：

| 路径 | 位置 |
|---|---|
| 落盘读取 | `freezeStoredEvents()`，标 `eventState: 'shared-frozen'` |
| 实时追加 | `createAppendEvent()` |
| Session 构造 | `constructor` seed 分支 |
| header | `validateSessionHeader()` |

`lib/fast-load.js` 替换 `SessionCorpus.prototype.load`：全部事件与 header 都已冻结时共享引用，否则退回原实现。每 60 秒输出 `FASTLOAD hits=N coldFallback=M`。

## 利用消息窗口收敛解决热开膨胀

原实现热开使用 `maxMessages: 500` + `turnWindow: { minMessages: 50, minTurns: 2 }`。膨胀来自 `minTurns: 2`：大会话单轮即 300+ 事件，500 的硬预算没机会生效。

插件对热开同样接管：去掉 `turnWindow`，`maxMessages` 收到上限。`hasMore` 仍由 `paginate` 如实返回，滚到顶部照常触发 `loadOlder`。

## 利用无渲染节点字段解决快照冗余

以下字段不参与首屏渲染，从快照中移除：

| 字段 | 依据 |
|---|---|
| `assistant/message.data.stream` | 客户端仅 trajectory 取 `firstTokenTime`，置 `[]` 后返回 `undefined`，调用处有 `??` 兜底 |
| `request/header.data.header.tools` | 仅「请求详情」面板使用，消费方为 `Array.isArray(rawTools) ? rawTools : []` |
| `job/registered` / `job/settled` 的 `label` | 工具命令原文，同轮 `tool/call.arguments` 已逐字包含 |
| 同上 `owner` | 恒等于本会话 id |

`job/*` 在客户端没有渲染节点：19 个引用它的文件里只有 `dsh-api-session-controller` 的已知类型白名单包含这两个类型。

`tool/call.arguments` 与 `tool/result.content` 保留。折叠行的摘要由它们算出（`dsh-client-ui-tool` 的 `deriveSummary()` 解析 `argsRaw`，兜底读 `firstLine(argsRaw)`）。本插件丢弃了宿主的完整 opening，尾部窗口是客户端唯一副本，裁掉后展开的工具卡片无法补回。

## 翻页不改写回包

改写 `loadOlder` 返回的页会导致上翻跳页。客户端的 `ChatViewport.historyConsumption()` 在 `native` 分支（用户正在滚动、`overflow-anchor` 可用）不做锚点补偿，依赖浏览器 `overflow-anchor`；同一文件的 `createFlowMotion` 在滚动动效激活时把 `overflowAnchor` 置为 `none`。

`historyRewrite` 默认 `false`，保留 `HISTORY-COST` 与 `HISTORY-PAGE` 两组计时。

## 命中条件

同时满足才走快路径，否则完全透传：

- 地址是普通会话（`kind: 'session'`）；
- `ctx.sessions.get(id) === undefined`；
- `sessionPersistence.stat(id)` 有当前格式代的 `.jsonl.zstd` 产物；
- 尾部解析得到连续且 seq 合法的窗口。

## 首屏契约

| 客户端要求 | 满足方式 |
|---|---|
| 末条记录 seq 等于 opening cursor | cursor 取真实尾部 seq |
| `assistantStream` 必须存在 | 给 `{ revision: 0 }` |
| `projections` 可缺 | 省略字段 |
| 记录连续 | 尾部窗口连续，已校验 seq |

省略 `projections`：`ProjectionValueStore.seed()` 会按 `asOfSeq` 清掉更晚的行，给空 baseline 会抹掉列表阶段已到达的投影值。

## 已知限制

- 投影值要等完整读取跑完才到（`todos` / `plan` / `inbox` / `goal` 等 key 会短暂读 `undefined`）；
- 窗口起点不做 `turn/start` 对齐，可能从一轮对话中间开始显示，往上滚一屏自动补齐；
- 原实现的全量读取仍会发生（省的是首屏等待与尾部读 I/O）。

## 诊断埋点

只读埋点写入 `$DSH_HOME/session-firstpaint.log`（内存缓冲 + 250 ms 批量落盘）。

| 埋点 | 输出行 | 含义 |
|---|---|---|
| 冷开首屏 | `BEGIN` / `HIT` / `EMIT` / `OPENING` | 首屏耗时、读取字节数 |
| 热开窗口 | `WARM` / `WARM-OPEN` | 窗口是否收窄、热开首帧耗时 |
| 主线程卡顿 | `LAG` | 卡顿时长、距冷开的毫秒数 |
| 冷读分段 | `PROFILE` | 读文件 / 解压+parse / 校验+冻结 |
| GC 归因 | `GCS` | 卡顿是否由 GC 引起 |

`PROFILE` 通过替换 `readStoredLog` / `decodeStoredLog` / `readZstdPrefix` 得到分段：

```
read            = total − decode
validate+freeze = decode − unzip+parse
```

`GCS` 的 `topGc` 给出最慢的几次 GC，`topStall` 给出最长的主线程阻塞。阈值默认 200 ms（`PROFILE`）/ 300 ms。

## 配置

```yaml
- id: session-firstpaint
  name: dsh-session-firstpaint
  config:
    maxMessages: 20              # 冷开与热开共用的消息上限
    memoBudgetMb: 1500           # 解码缓存字节预算
    memoHeapHighWaterMb: 3000    # 堆压力高水位
    historyPageEvents: 300       # 翻页统计阈值
    historyRewrite: false        # 改写翻页回包（会跳页）
    prefetchMessages: 5          # 首屏预缓存消息数
    prefetchBudgetKb: 4096       # 预缓存内存上限
    prefetchDelayMs: 30000       # 启动后延迟
    profileThresholdMs: 200      # 冷读记录阈值
    stallThresholdMs: 120        # 卡顿阈值
    gcThresholdMs: 150           # GC 阈值
    sample: false                # 一次性 CPU 采样
    sampleWindowMs: 60000
    sampleIntervalUs: 10000
```

## 停用与还原

```yaml
- id: session-firstpaint
  disabled: true
```

卸载时 `ctx.effect` 的还原函数把 `prototype.follow` 换回原方法。HMR 下旧 fiber 的 cleanup 可能晚于新 fiber 的 apply，因此 `PATCHED` 存还原函数本身：新装载先调用它摘掉旧包装，还原时核对 `proto.follow` 是否仍是自己装的。

`memo-budget` 以 `open` 所在原型为主锚点定位宿主对象，依次尝试 `open` 原型 → 其上层 → 全链 → 实例自身，失败时把原型链写入日志（`MEMOBUDGET-SKIP ... chain=...`），命中时日志带 `via=open-proto`。

## 自测

```sh
node test.mjs
```

八个用例：冷会话命中、已 attach 透传、无产物退回、还原后原型恢复、子代理地址不拦截、配置传入与首屏裁剪字段、冷开记录不被热开覆盖、热开窗口收敛。测试用 `node:zlib` 现场造带 checksum 的同格式日志。

## 性能对比

### 冷开全量解码（被消除的部分）

| 日志 | 解压后 | 事件 | 耗时 |
|---|---|---|---|
| 54.0 MB | 175.7 MB | 63234 | 解压 3.6 s + 解析 2.4 s + 冻结 0.24 s |
| 36.1 MB | 129.6 MB | 44380 | 解压 2.3 s + 解析 1.8 s |

### 首屏

| 日志 | 尾部读 | 首屏事件 | 耗时 |
|---|---|---|---|
| 55.0 MB | 4.00 MB | 295 | 131 ms |
| 61.4 MB | 4.00 MB | 345 | 67 ms |
| 37.2 MB | 4.00 MB | 334 | 84 ms |
| 31.7 MB | 4.00 MB | — | 86 ms |
| 27.4 MB | 4.00 MB | — | 97 ms |

合计磁盘读 20.0 MB，整份读为 212.6 MB。线上 `firstpaint=114–120 ms`，完整读取约 4–6 s。

### 解码缓存

5 个最大会话，按顺序开第二遍：

| | A 61.4 MB | B 57.8 MB | C 43.5 MB | D 41.0 MB | E 28.8 MB |
|---|---|---|---|---|---|
| 宿主（2 条） | 7 ms | 3329 ms | 2687 ms | — | — |
| 1500 MB 预算 | 9 ms | 7 ms | 8 ms | 7 ms | 7 ms |

命中率 2/5 → 5/5。`heapUsed` 峰值 1380 MB（上限 4192 MB），驻留约 4.6 KB/事件（61.4 MB / 78557 事件 → +357 MB）。

4 个最大会话的 CPU 采样（19219 ms）显示命中时省掉的部分：

```
consumeEventLine  7726 ms  40.2%     decodeFrame   2957 ms  15.4%
GC                1464 ms   7.6%     freeze        1144 ms   6.0%
utf8Slice         1049 ms   5.5%     行校验         243 ms   1.3%
```

### 快照裁剪

8 个最大会话的尾部窗口（各 20 条消息）：

| 压缩后 | 事件 | 原始 | 裁剪后 | 比例 |
|---|---|---|---|---|
| 61.4 MB | 159 | 261 KB | 129 KB | 49.4% |
| 57.9 MB | 120 | 380 KB | 137 KB | 36.1% |
| 43.8 MB | 132 | 206 KB | 108 KB | 52.4% |
| 41.0 MB | 116 | 396 KB | 181 KB | 45.7% |
| 28.8 MB | 77 | 114 KB | 68 KB | 59.6% |
| 25.2 MB | 163 | 429 KB | 331 KB | 77.2% |
| 22.3 MB | 111 | 308 KB | 88 KB | 28.6% |
| 20.0 MB | 104 | 127 KB | 63 KB | 49.6% |
| 合计 | — | 2221 KB | 1105 KB | 50.2% |

校验（103 个 job 事件、89 个 `tool/result`、90 个 `tool/call`）：`job.label` 与 `job.owner` 残留 0；`tool/result.content` 保留 89/89；`tool/call.arguments` 保留 89/90（1 个本身为空串）；`tool/ptc-dispatch.arguments` 保留 43/43。

### 热开窗口

| | 500/2轮 | 500/1轮 | 60/无turn窗 |
|---|---|---|---|
| 会话1 | 327 事件 / 1.31 MB | 327 / 1.31 | 345 / 1.37 |
| 会话2 | 749 事件 / 1.68 MB | 749 / 1.68 | 430 / 0.90 |
| 会话3 | 637 事件 / 1.20 MB | 630 / 1.18 | 355 / 0.66 |

配合快照裁剪后：1.31 → 0.91 MB、1.68 → 0.83 MB、1.20 → 0.60 MB。

### 深拷贝

33 MB / 43950 事件会话：

| 做法 | 耗时 | 堆 |
|---|---|---|
| `structuredClone` 全部事件 | 1441～2243 ms | +418 MB |
| 共享同一批引用 | 2 ms | +0 |
