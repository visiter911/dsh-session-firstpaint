/**
 * dsh-session-firstpaint — 冷会话首屏尾部优先读取（host 半边）。
 *
 * 问题：冷会话打开时 `SessionController.follow` 必须先 `observeSession`，
 * 而那一步要把整份日志解压 + 逐行 JSON.parse + 冻结 + 重建 Session 才能分页。
 * 实测 54 MB / 34949 帧 / 63234 事件需要约 6 s，期间主线程被连续同步工作占住，
 * 发送与终止按钮一起卡住。
 *
 * 做法：不改任何包，在插件启动时替换 `SessionController.prototype.follow`。
 * 命中「冷会话」条件时：
 *   1. 先把原实现的迭代器启动起来（它在第一个 await 之前就注册好事件监听，
 *      所以此后到达的事件都不会丢）；
 *   2. 只做帧结构扫描 + 从尾部往前解压若干帧，立刻 yield 一个尾部窗口的
 *      opening snapshot，首屏可见；
 *   3. 再丢弃原实现那份等价 opening，只转发它排队中的增量事件。
 * 未命中条件、或尾部读失败时完全退回原实现。
 *
 * 这是纯运行时补丁：不改 asar、不改 profile 文件、不重启；卸载插件即还原。
 */

import { appendFileSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readTailEventsFromFile } from './lib/tail-read.js'
import { installProfile, installQueryProbe } from './lib/profile.js'
import { installGcWatch } from './lib/gc-watch.js'
import { sampleOnce } from './lib/sample.js'
import { installFastLoad } from './lib/fast-load.js'
import { installQueryFastPath } from './lib/query-fast.js'
import { installPrefetch, PREFETCH_DEFAULTS } from './lib/prefetch.js'
import { installHistoryCap } from './lib/history-cap.js'
import { installMemoBudget, MEMO_BUDGET_DEFAULTS } from './lib/memo-budget.js'

export const name = 'session-firstpaint'

/** 需要等待这些服务就绪后再打补丁。 */
export const inject = [
  'sessionController',
  'sessions',
  'sessionPersistence',
  'sessionQuery',
  'workspaceRegistry',
]

/** 未安装预缓存时的空实现，保证 follow 分支不必判空。 */
const NULL_PREFETCH = {
  lookup: () => undefined,
  stop: () => {},
  stats: () => ({ hits: 0, misses: 0, built: 0, entries: 0, usedBytes: 0 }),
}

/** 打补丁标记，避免热重载时重复包装。 */
const PATCHED = Symbol.for('dsh.sessionFirstpaint.patched')

/** 首屏目标消息条数；够渲染最近几轮对话即可。 */
const DEFAULT_MAX_MESSAGES = 50

/**
 * 客户端 `HISTORY_PAGE_OPTIONS.maxMessages` 的取值。
 * 客户端没显式给 maxMessages 时按它算，才能判断是否真的需要收窄。
 */
const DEFAULT_CLIENT_MAX_MESSAGES = 500

/** 诊断日志：固定文件，方便直接看首屏到底花了多久。 */
function diagPath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'session-firstpaint.log')
}

/**
 * 诊断日志缓冲：**绝不**在关键路径上做同步文件 I/O。
 *
 * 旧实现每行都 `statSync` + `appendFileSync`：前者是同步 syscall，
 * 后者在 Windows 上还要拿文件锁。冷开时一屏写 5～6 行，正好落在
 * 主线程最忙的窗口里，反而给点击延迟贡献了几十毫秒。
 * 改成攒在内存里、由 unref 的定时器每 250 ms 批量落盘一次。
 */
const diagBuffer = []
let diagFlushTimer = null
let diagBytesSinceRotate = 0

/** 把缓冲行一次性追加到日志文件；失败就丢掉这批，绝不影响主流程。 */
function flushDiag() {
  if (diagBuffer.length === 0) return
  const lines = diagBuffer.splice(0, diagBuffer.length).join('')
  try {
    const path = diagPath()
    appendFileSync(path, lines)
    diagBytesSinceRotate += lines.length
    // 轮转只在确实超过阈值时做一次，而不是每次写都 statSync。
    if (diagBytesSinceRotate > 512 * 1024) {
      diagBytesSinceRotate = 0
      try {
        if (statSync(path).size > 512 * 1024) renameSync(path, `${path}.1`)
      } catch {
        // 文件不存在：无需轮转。
      }
    }
  } catch {
    // 诊断失败不影响主流程。
  }
}

/**
 * 近期业务事件轨迹：回答「卡顿时正在干什么」。
 *
 * heap 数字只能说明「涨了」，不能说明「谁在分配」。
 * 卡顿往往发生在一次长同步工作的中间，那时没有任何日志产出，
 * 所以要把**卡顿之前**最后几条业务日志留下来，附在 STALL 行上。
 *
 * 只保留最近 12 条、跳过 STALL/GC 自身（否则轨迹会被观测自己的输出淹没）。
 */
const trailRing = []
const TRAIL_MAX = 12

/** 记录一条业务事件（第一段标识即可，足够定位阶段）。 */
function noteTrail(label) {
  trailRing.push({ at: Date.now(), label })
  if (trailRing.length > TRAIL_MAX) trailRing.shift()
}

/**
 * 读出卡顿前的业务轨迹。
 *
 * @returns {Array<{at: string, label: string}>} 相对时刻 + 标签，最旧在前。
 */
function readTrail() {
  const now = Date.now()
  return trailRing.map(item => ({
    // 用「距今多久」表示：卡顿时刻往回数，比绝对时刻更好读。
    at: `-${Math.max(0, now - item.at)}ms`,
    label: item.label,
  }))
}

/** 追加一行诊断（纯内存操作，调用方可以放心放在关键路径上）。 */
function diag(line) {
  // 观测自身的输出不进轨迹，否则会把自己淹没。
  if (!line.startsWith('STALL ') && !line.startsWith('GC ')) {
    const space = line.indexOf(' ')
    noteTrail(space < 0 ? line : line.slice(0, space))
  }
  diagBuffer.push(`${new Date().toISOString()} ${line}\n`)
  if (diagBuffer.length > 512) diagBuffer.splice(0, diagBuffer.length - 512)
  if (diagFlushTimer !== null) return
  diagFlushTimer = setTimeout(() => {
    diagFlushTimer = null
    flushDiag()
  }, 250)
  if (typeof diagFlushTimer.unref === 'function') diagFlushTimer.unref()
}

/** 卡顿采样间隔：比一帧略长，足以区分「正常调度」与「主线程被占」。 */
const LAG_SAMPLE_MS = 25

/** 一次冷开之后继续监测的时长，覆盖后台全量读跑完的整个过程。 */
const LAG_WINDOW_MS = 15000

/** 超过这个延迟才算一次卡顿。 */
const LAG_THRESHOLD_MS = 50

/** 最近一次冷开的起点；点击类操作把它当参考零点。 */
let coldOpen = { at: 0, sessionId: '' }

/** 正在运行的卡顿监测定时器；新的冷开会替换旧的。 */
let lagTimer = null

/**
 * 在冷开窗口内采样主线程卡顿。
 *
 * 原理：`setInterval(25ms)` 每次触发时，实际间隔与 25 ms 的差值就是
 * 事件循环被同步代码占住的时间。点击「发送」「终止」之所以会延迟，
 * 正是因为它们的 RPC 处理也要排在这条被占住的主线程后面。
 *
 * 只放一个定时器、只在冷开窗口内运行，对被测对象没有可测量影响。
 * @param {string} sessionId - 触发监测的会话。
 */
function startLagMonitor(sessionId) {
  stopLagMonitor()
  const startedAt = Date.now()
  let last = startedAt
  let samples = 0
  let maxLag = 0
  let overThreshold = 0
  let over200 = 0
  /** 最严重的若干次，按延迟降序保留。 */
  const worst = []

  lagTimer = setInterval(() => {
    const now = Date.now()
    const lag = now - last - LAG_SAMPLE_MS
    last = now
    samples += 1
    if (lag > maxLag) maxLag = lag
    if (lag > LAG_THRESHOLD_MS) {
      overThreshold += 1
      if (lag > 200) over200 += 1
      worst.push({ at: now - startedAt, lag })
      worst.sort((left, right) => right.lag - left.lag)
      if (worst.length > 8) worst.length = 8
    }
    if (now - startedAt >= LAG_WINDOW_MS) {
      stopLagMonitor()
      diag(
        `LAG ${sessionId} samples=${samples} max=${maxLag}ms`
        + ` over50=${overThreshold} over200=${over200}`
        + ` worst=${worst.map(item => `+${item.at}:${item.lag}`).join(',') || 'none'}`,
      )
    }
  }, LAG_SAMPLE_MS)

  if (typeof lagTimer.unref === 'function') lagTimer.unref()
}

/** 停掉正在运行的卡顿监测。 */
function stopLagMonitor() {
  if (lagTimer !== null) {
    clearInterval(lagTimer)
    lagTimer = null
  }
}

/**
 * 从地址里取会话 id。只处理普通会话地址，子代理地址不拦截。
 * @param {object} address - `{ kind: 'session', sessionId }` 或子代理地址。
 * @returns {string | undefined} 普通会话 id，其它形态返回 undefined。
 */
function addressSessionId(address) {
  if (address === null || typeof address !== 'object') return undefined
  if (address.kind !== 'session') return undefined
  return typeof address.sessionId === 'string' ? address.sessionId : undefined
}

/**
 * 尝试尾部优先读取。
 *
 * 先查首屏预缓存：命中且 revision 一致时直接用，省掉整段尾部读
 * （线上实测 `read=100~1004ms`，只剩 `stat=12~184ms`）。
 * 未命中才走原来的「读文件尾部 + 解压窗口」。
 * @param {object} ctx - 插件上下文。
 * @param {string} sessionId - 会话 id。
 * @param {function} log - 宿主日志。
 * @param {object | undefined} config - 插件配置。
 * @param {object} prefetch - 首屏预缓存接口。
 * @param {AbortSignal | undefined} signal - 取消信号。
 * @returns {Promise<object | undefined>} 首屏 snapshot 帧。
 */
async function tryTailFirst(ctx, sessionId, log, config, prefetch, signal) {
  const tStat = Date.now()
  let stat
  try {
    stat = await ctx.sessionPersistence.stat(sessionId)
  } catch (error) {
    log(`stat 失败，退回原实现：${String(error)}`)
    diag(`MISS stat-failed ${sessionId} ${String(error)}`)
    return undefined
  }
  const statMs = Date.now() - tStat
  if (stat === undefined) {
    diag(`MISS no-stat ${sessionId}`)
    return undefined
  }
  // 只处理当前格式代的 zstd 产物；历史代与未压缩布局都退回。
  const location = stat.location
  if (location === undefined || typeof location.path !== 'string') return undefined
  if (!location.path.endsWith('.jsonl.zstd')) return undefined

  // ---- 预缓存命中：尾部窗口已经在空闲时算好，直接用 ----
  const cached = prefetch.lookup(location.path)
  if (cached !== undefined) {
    const totalMs = Date.now() - tStat
    log(`首屏命中预缓存：${cached.records.length} 条事件，cursor=${cached.cursor}，用时 ${totalMs} ms`)
    diag(
      `HIT-CACHED ${sessionId} stat=${statMs}ms total=${totalMs}ms`
      + ` records=${cached.records.length} cursor=${cached.cursor}`,
    )
    return cached
  }

  // 只读文件尾部，不整份载入：紧随其后的原实现还要把整份日志读一遍，
  // 这里也整份读会让一次冷开的磁盘读翻倍。
  const tRead = Date.now()
  let tail
  try {
    tail = await readTailEventsFromFile({
      path: location.path,
      maxMessages: resolveMaxMessages(config),
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true) return undefined
    log(`尾部读取失败，退回原实现：${String(error)}`)
    diag(`MISS read-failed ${sessionId} ${String(error)}`)
    return undefined
  }
  const readMs = Date.now() - tRead
  if (tail === undefined) {
    log('尾部解析未得到连续窗口，退回原实现')
    diag(`MISS tail-failed ${sessionId}`)
    return undefined
  }
  const totalMs = statMs + readMs

  const header = stat.header
  const snapshot = {
    type: 'snapshot',
    header: {
      version: header.version,
      id: header.id,
      createdAt: header.createdAt,
      isSeeded: header.isSeeded,
      ...header.cwd === undefined ? {} : { cwd: header.cwd },
      ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
      ...header.origin === undefined ? {} : { origin: header.origin },
      ...header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth },
      ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
    },
    cursor: tail.cursor,
    records: tail.events.map(event => ({ type: 'event', event })),
    hasMore: tail.hasMore,
    // 冷会话没有活跃的 assistant 尝试；客户端要求这个字段存在。
    assistantStream: { revision: 0 },
    // 故意不给 projections：客户端对 undefined 有分支，而给空 baseline 会把
    // 已到达的投影行按 asOfSeq 清掉。投影留给原实现的完整读取推送。
  }
  log(`首屏命中：${tail.events.length} 条事件（${tail.messages} 条消息），cursor=${tail.cursor}，解码 ${tail.decodedFrames}/${tail.frames} 帧，只读 ${(tail.bytesRead / 1048576).toFixed(2)} MB，用时 ${totalMs} ms`)
  diag(
    `HIT ${sessionId} bytesRead=${(tail.bytesRead / 1048576).toFixed(2)}MB`
    + ` window=${(tail.windowBytes / 1048576).toFixed(2)}MB fromStart=${tail.fromFileStart}`
    + ` stat=${statMs}ms read=${readMs}ms total=${totalMs}ms`
    + ` events=${tail.events.length} messages=${tail.messages}`
    + ` frames=${tail.decodedFrames}/${tail.frames}`
    + ` payload=${tail.rawKB}KB->${tail.trimmedKB}KB cursor=${tail.cursor}`,
  )
  return snapshot
}

/**
 * 首屏预缓存每条保留的消息条数。
 *
 * 比 `maxMessages` 小：预缓存只需要「打开就能看到最近几轮」，
 * 更早的内容客户端上滚时会照常 `loadOlder` 补齐。
 * @param {object | undefined} config - 插件配置。
 * @returns {number} 正整数。
 */
function resolvePrefetchMessages(config) {
  const configured = config?.prefetchMessages
  if (typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0) {
    return configured
  }
  return PREFETCH_DEFAULTS.messages
}

/**
 * 首屏预缓存的内存上限（字节）。
 * @param {object | undefined} config - 插件配置。
 * @returns {number} 正整数字节数。
 */
function resolvePrefetchBudget(config) {
  const kb = config?.prefetchBudgetKb
  if (typeof kb === 'number' && Number.isSafeInteger(kb) && kb > 0) {
    return kb * 1024
  }
  return PREFETCH_DEFAULTS.budgetBytes
}

/**
 * 解码缓存的内存预算（字节）。
 * @param {object | undefined} config - 插件配置。
 * @returns {number} 正整数字节数。
 */
function resolveMemoBudget(config) {
  const mb = config?.memoBudgetMb
  if (typeof mb === 'number' && Number.isSafeInteger(mb) && mb > 0) {
    return mb * 1024 * 1024
  }
  return MEMO_BUDGET_DEFAULTS.budgetBytes
}

/**
 * 解码缓存的堆压力高水位（字节）。
 * @param {object | undefined} config - 插件配置。
 * @returns {number} 正整数字节数。
 */
function resolveMemoHighWater(config) {
  const mb = config?.memoHeapHighWaterMb
  if (typeof mb === 'number' && Number.isSafeInteger(mb) && mb > 0) {
    return mb * 1024 * 1024
  }
  return MEMO_BUDGET_DEFAULTS.heapHighWaterBytes
}

/**
 * 读取首屏条数上限。配置从 apply(ctx, config) 传进来，绝不读 ctx.config：
 * 那是 Cordis 的受 inject 校验访问器，本插件没 inject 'config'，
 * 直接访问会抛 "cannot get property config without inject"。
 * @param {object | undefined} config - 插件配置。
 * @returns 合法的正整数，否则默认值。
 */
function resolveMaxMessages(config) {
  const configured = config?.maxMessages
  if (typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0) {
    return configured
  }
  return DEFAULT_MAX_MESSAGES
}

/**
 * 把一次 follow 请求收敛成真正的滑动窗口。
 *
 * 实测发现关键点：**`turnWindow.minTurns` 才是窗口膨胀的主因**。
 * 它要求「至少凑满 2 整轮」，而大会话单轮就有 300+ 事件，
 * 所以 `maxMessages: 500` 的硬预算根本没机会生效——
 * 三个大会话实测分别是 327 / 749 / 637 事件、1.2–1.7 MB，
 * 把 maxMessages 从 500 降到 60 也几乎没用（仍 327 / 430 / 355）。
 *
 * 因此这里同时去掉 `turnWindow` 并把 `maxMessages` 收到上限：
 * 窗口变成纯粹的「最近 N 条消息」。`hasMore` 仍由 paginate 如实返回，
 * 客户端滚到顶部会照常触发 `loadOlder` 往前补一页，也就是滑动窗口。
 *
 * 代价是首屏起点可能落在一轮对话中间。这是可接受的：
 * 1. 冷开路径本来就是从尾部直接截断（不对齐 turn/start）；
 * 2. 用户往上滚一屏就自动补齐整轮。
 *
 * @param {object} request - 原始 follow 请求。
 * @param {number} cap - 窗口上限（消息条数）。
 * @returns {object} 新的请求对象；无需收窄时原样返回。
 */
function capFromRequest(request, cap) {
  const current = request?.maxMessages
  // 未指定时按客户端常量 500 处理；已经不大于上限且没有 turnWindow 就原样返回。
  const effective = typeof current === 'number' ? current : DEFAULT_CLIENT_MAX_MESSAGES
  if (effective <= cap && request?.turnWindow === undefined) return request
  const { turnWindow, ...rest } = request
  return { ...rest, maxMessages: cap }
}

/** 把日志行写进宿主 logger，便于用户判断补丁是否生效。 */
function makeLog(ctx) {
  return (line) => {
    try {
      ctx.logger.info(`[firstpaint] ${line}`)
    } catch {
      // logger 不可用时静默：诊断信息不值得让插件失败。
    }
  }
}

/**
 * 当前活跃的打开请求。
 *
 * 用户快速切换会话时，旧会话的完整读取仍在后台跑（那是秒级的同步解码）。
 * 新请求进来时先把上一个中止掉，让 zstd 解码循环在下一个
 * `throwIfAborted()` 检查点退出，把主线程让给新的那一页。
 *
 * 只记录**本插件发起的**调用：客户端自己的 signal 不在这里，
 * 中止一个 follow 只影响我们包装过的那条迭代链。
 */
let activeOpen = undefined

/**
 * 切换爆发的合并统计。
 *
 * 连按方向键翻会话列表时，`follow` 每秒能跑 5 次左右。
 * 每次打印 3 行诊断，2 分 44 秒就能刷出 2571 行——诊断本身成了开销，
 * 也把真正有用的慢日志淹没了。
 *
 * 所以这里只做累加，由 `logBurst` 在爆发结束后合并成一行。
 */
const burst = {
  warm: 0,
  warmOpen: 0,
  cancelled: 0,
  firstMsSum: 0,
  firstMsMax: 0,
  firstMsCount: 0,
  windowStart: 0,
}

/** 最近一次热开的结果，供爆发结束时的汇总行引用。 */
let latestWarmOpen = undefined

/** 爆发窗口：超过这么久没有新动作，就认为一次浏览结束并输出汇总。 */
const BURST_IDLE_MS = 2000

/** 正在等待输出的定时器。 */
let burstTimer = null

/**
 * 记一次切换活动。
 * @param {'warm' | 'warmOpen' | 'cancelled'} kind - 活动类型。
 * @param {number | undefined} firstMs - 热开首帧耗时。
 * @param {number | undefined} records - 首帧记录数。
 */
function noteFire(kind, firstMs, records) {
  const now = Date.now()
  if (burst.windowStart === 0) burst.windowStart = now
  burst[kind] += 1
  if (firstMs !== undefined) {
    burst.firstMsSum += firstMs
    burst.firstMsCount += 1
    if (firstMs > burst.firstMsMax) burst.firstMsMax = firstMs
  }
  void records
  if (burstTimer !== null) clearTimeout(burstTimer)
  burstTimer = setTimeout(flushBurst, BURST_IDLE_MS)
  if (typeof burstTimer.unref === 'function') burstTimer.unref()
}

/**
 * 输出一次浏览爆发的汇总。
 *
 * 只在真正发生过切换时输出；空闲时什么都不写。
 */
function flushBurst() {
  burstTimer = null
  const total = burst.warm + burst.cancelled
  if (total === 0) {
    burst.windowStart = 0
    return
  }
  const seconds = Math.max(0.001, (Date.now() - burst.windowStart) / 1000)
  const avg = burst.firstMsCount === 0 ? 0 : burst.firstMsSum / burst.firstMsCount
  const last = latestWarmOpen
  diag(
    `WARM-BURST switches=${total} opened=${burst.warmOpen} cancelled=${burst.cancelled}`
    + ` ${seconds.toFixed(1)}s (${(total / seconds).toFixed(1)}/s)`
    + ` first avg=${avg.toFixed(0)}ms max=${burst.firstMsMax}ms`
    + (last === undefined ? '' : ` last=${last.sessionId} ${last.firstMs}ms`)
    + ` cap=${burstCap}`,
  )
  burst.warm = 0
  burst.warmOpen = 0
  burst.cancelled = 0
  burst.firstMsSum = 0
  burst.firstMsMax = 0
  burst.firstMsCount = 0
  burst.windowStart = 0
}

/** 爆发汇总行里回显的消息上限，便于对照。 */
let burstCap = DEFAULT_MAX_MESSAGES

/**
 * 替换 prototype 上的 follow，返回还原函数。
 * @param {object} ctx - 插件上下文（含三个注入服务）。
 * @param {object | undefined} config - 插件配置（由 apply 传入，不能读 ctx.config）。
 */
function installPatch(ctx, config, prefetch) {
  const service = ctx.sessionController
  const proto = Object.getPrototypeOf(service)
  if (proto === null || typeof proto.follow !== 'function') {
    ctx.logger.warn('[firstpaint] 找不到 SessionController.follow，补丁未安装')
    return () => {}
  }
  const previousRestore = proto[PATCHED]
  if (typeof previousRestore === 'function') {
    // HMR 重载时旧 fiber 的还原函数可能还没跑，也可能永远不会跑。
    // 先执行它把旧包装摘掉，否则磁盘上的新代码不会被加载
    // （旧实现此处直接 return，导致改代码后仍跑旧版本）。
    try {
      previousRestore()
    } catch (error) {
      ctx.logger.warn(`[firstpaint] 摘除旧补丁失败：${String(error)}`)
    }
  }
  // previousRestore 已把 proto 还原到原始 follow；再取一次基准。
  const original = proto.follow
  const log = makeLog(ctx)

  async function* follow(request, signal) {
    const sessionId = addressSessionId(request?.address)
    const cold = sessionId !== undefined && ctx.sessions.get(sessionId) === undefined

    // ---- 只在「还有昂贵后台工作」时才驱逐上一个 ----
    //
    // `follow` 是持久订阅，不是一次性请求：首帧交出后它还要一直开着收新事件。
    // 之前无条件 abort 上一个，导致热会话刚出首帧（1~2ms）就被 40ms 后的
    // 下一次切换中断（实测 CANCEL-STALE 紧跟在 WARM-OPEN 后面），
    // 客户端那条流提前结束、来不及渲染，界面看着像「没切换成功」。
    //
    // 所以只在这两种情况下中断：
    //   1. 上一次还没交出首帧（settled=false）——避免无谓启动；
    //   2. 上一次是冷会话——它首帧之后还有秒级的完整解码在抢主线程。
    // 热会话已出首帧时**不中断**：那没有昂贵后台工作，中断只会破坏渲染。
    if (sessionId !== undefined) {
      const previous = activeOpen
      const worthEvicting = previous !== undefined
        && previous.sessionId !== sessionId
        && previous.controller.signal.aborted === false
        && (previous.settled === false || previous.cold === true)
      if (worthEvicting) {
        noteFire('cancelled')
        previous.controller.abort(new Error('superseded by another session open'))
      }
      const controller = new AbortController()
      const entry = { sessionId, controller, cold, settled: false }
      activeOpen = entry
      try {
        yield* followBody.call(this, request, signal, controller.signal, cold, entry)
      } finally {
        // 只有仍是最新那个才清空，避免把后来者清掉。
        if (activeOpen === entry) activeOpen = undefined
      }
      return
    }
    yield* followBody.call(this, request, signal, undefined, cold, undefined)
  }

  /**
   * follow 的实际实现。
   * @param {object} request - 原始请求。
   * @param {AbortSignal | undefined} signal - 客户端取消信号。
   * @param {AbortSignal | undefined} cancelSignal - 本插件的中止信号（被新会话取代时触发）。
   * @param {boolean} cold - 是否冷会话。
   * @param {object | undefined} entry - 活跃请求记录，交出首帧后标记 settled。
   */
  async function* followBody(request, signal, cancelSignal, cold, entry) {
    const sessionId = addressSessionId(request?.address)
    /**
     * 合并后的取消信号。
     *
     * 必须把插件的 `cancelSignal` 并进真实的 signal 再交给原实现：
     * 宿主内部（`readZstdPrefix` 的解压循环）检查的是它收到的那个 signal，
     * 只在 `yield* original.call(this, request, signal)` 里传客户端 signal
     * 的话，「被新会话取代」永远不会传达到解码循环。
     */
    const merged = signal === undefined
      ? cancelSignal
      : cancelSignal === undefined
        ? signal
        : AbortSignal.any([signal, cancelSignal])
    /** 两个信号任一触发就算中止。 */
    const aborted = () => signal?.aborted === true || cancelSignal?.aborted === true

    // 上限值：冷热共用同一个配置，保证两条路径的可感受延迟一致。
    const cap = resolveMaxMessages(config)

    // 热会话也要收窄窗口。原实现固定用 maxMessages: 500 + turnWindow.minTurns: 2，
    // 后者会为了凑满两整轮继续往前吃，实测一次热开要搬 327–749 条、1.2–1.7 MB，
    // 比冷开还重 3–4 倍。收窄后 hasMore 仍由 paginate 如实返回，
    // 客户端上滚时照常自动补更早的历史（滑动窗口）。
    const windowed = capFromRequest(request, cap)
    if (!cold && windowed !== request) {
      const tWarm = Date.now()
      burstCap = cap
      // 连按方向键时这里每秒会跑好几次，逐次打印会让日志量翻几倍
      // （实测 2 分 44 秒刷了 857 组三行）。改成累计，爆发结束后合并输出。
      noteFire('warm')
      let first = true
      for await (const frame of original.call(this, windowed, merged)) {
        if (first) {
          first = false
          const firstMs = Date.now() - tWarm
          const records = frame?.type === 'snapshot' ? (frame.records?.length ?? 0) : 0
          noteFire('warmOpen', firstMs, records)
          latestWarmOpen = { sessionId, firstMs, records, at: Date.now() }
          // 首帧已交出：热会话此后不再有昂贵后台工作，标记 settled，
          // 后续切换就不会再来 abort 这条流（否则界面刚渲染就被打断）。
          if (entry !== undefined) entry.settled = true
        }
        yield frame
      }
      return
    }

    const tFollow = Date.now()
    if (cold) {
      coldOpen = { at: tFollow, sessionId }
      diag(`BEGIN ${sessionId} cold=true cap=${cap}`)
      startLagMonitor(sessionId)
    }

    if (cold) {
      // 先把原实现跑起来：它在本体第一个 await 之前就建好 EventListener，
      // 所以从现在起产生的事件都进它的缓冲队列，不会在我们出首屏的空窗里丢掉。
      let inner
      let pending
      try {
        inner = original.call(this, request, merged)[Symbol.asyncIterator]()
        pending = inner.next()
        // 立刻观察拒绝，避免未处理拒绝。
        void pending.catch(() => undefined)
      } catch (error) {
        log(`启动原实现失败，直接转交：${String(error)}`)
        diag(`MISS inner-start-failed ${sessionId} ${String(error)}`)
        inner = undefined
      }

      let snapshot
      try {
        // 把插件的取消信号一起传下去：尾部读内部的解压循环会检查它。
        snapshot = await tryTailFirst(ctx, sessionId, log, config, prefetch, cancelSignal ?? signal)
      } catch (error) {
        log(`尾部读取异常，退回原实现：${String(error)}`)
        diag(`MISS tail-threw ${sessionId} ${String(error)}`)
        snapshot = undefined
      }

      if (inner !== undefined) {
        if (snapshot !== undefined) {
          diag(`EMIT ${sessionId} firstpaint=${Date.now() - tFollow}ms`)
          const tEmit = Date.now()
          // 冷会话首帧交出后**仍然**标记 settled，但它 `cold=true`，
          // 驱逐判定里依然会被中断——因为首帧之后还有秒级的完整解码
          // 在抢主线程，那才是必须打断的部分。
          if (entry !== undefined) entry.settled = true
          yield snapshot
          try {
            // 丢弃原实现那份等价 opening（cursor 与上面同一个尾部 seq）。
            const opening = await pending
            diag(`OPENING ${sessionId} resumeWatch=${Date.now() - tEmit}ms afterEmit total=${Date.now() - tFollow}ms cursor=${opening.done === true ? 'done' : opening.value?.cursor}`)
            if (opening.done === true) return
            // 首屏之后的完整读取是最贵的一段（秒级同步解码）。
            // 一旦被新会话取代就立刻退出，不要继续抢主线程。
            for (;;) {
              if (aborted()) return
              const next = await inner.next()
              if (next.done === true) return
              yield next.value
            }
          } finally {
            await inner.return?.(undefined)
          }
          return
        }
        // 没走快路径：把已经启动的迭代器原样转交，不重复启动。
        try {
          const first = await pending
          if (first.done === true) return
          yield first.value
          for (;;) {
            if (aborted()) return
            const next = await inner.next()
            if (next.done === true) return
            yield next.value
          }
        } finally {
          await inner.return?.(undefined)
        }
        return
      }
    }

    yield* original.call(this, request, merged)
  }

  Object.defineProperty(proto, 'follow', {
    value: follow,
    writable: true,
    configurable: true,
    enumerable: false,
  })
  // 存还原函数本身，而不是 `true`：下一次 HMR 装载要能借此摘掉旧包装。
  proto[PATCHED] = restore
  log('SessionController.follow 已替换为尾部优先实现')

  function restore() {
    // 迟到的旧 restore 不得摘掉已经装上的新补丁：只有当前 follow 仍是自己
    // 装的那个时才还原。HMR 下旧 fiber 的 cleanup 可能晚于新 fiber 的 apply。
    if (proto.follow !== follow) {
      log('还原跳过：当前 follow 已不是本次安装的实现')
      return
    }
    Object.defineProperty(proto, 'follow', {
      value: original,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    delete proto[PATCHED]
    stopLagMonitor()
    log('SessionController.follow 已还原')
  }

  return restore
}

/**
 * 插件入口：安装运行时补丁，并注册还原。
 * @param {object} ctx - 插件上下文。
 * @param {object | undefined} config - 插件配置，由 Loader 传入而不是读 ctx.config。
 */
export function apply(ctx, config) {
  // 首屏预缓存：把「未归档普通会话」的尾部窗口在空闲时先算好。
  // 实测 29 个目标、28 个可缓存、总占用 288 KB，冷开省掉 100~1000 ms。
  // 必须在 follow 补丁之前装好，补丁闭包要拿到同一个 cache 实例。
  let prefetch = NULL_PREFETCH
  ctx.effect(
    () => {
      prefetch = installPrefetch({
        persistence: ctx.sessionPersistence,
        workspaceRegistry: ctx.workspaceRegistry,
        maxMessages: () => resolvePrefetchMessages(config),
        diag,
        budgetBytes: resolvePrefetchBudget(config),
        delayMs: config?.prefetchDelayMs,
      })
      return () => {
        prefetch.stop()
        prefetch = NULL_PREFETCH
      }
    },
    'session-firstpaint: prefetch',
  )
  ctx.effect(() => installPatch(ctx, config, prefetch), 'session-firstpaint: follow patch')
  // 解码缓存扩容：宿主写死只缓存 2 个会话，切第三个就挤出第一个，
  // 切回来又要 2~4 秒重新解码。这里换成字节预算 + LRU（默认 900 MB）。
  // 必须在任何会话被打开之前装好，否则早期解码进不了新策略。
  let memoBudget = { stop() {}, stats() { return {} } }
  ctx.effect(
    () => {
      memoBudget = installMemoBudget({
        persistence: ctx.sessionPersistence,
        diag,
        budgetBytes: resolveMemoBudget(config),
        heapHighWaterBytes: resolveMemoHighWater(config),
      })
      return () => {
        memoBudget.stop()
        memoBudget = { stop() {}, stats() { return {} } }
      }
    },
    'session-firstpaint: memo budget',
  )
  // 翻历史那一页不经过 follow：客户端 loadOlder 自带
  // `maxMessages: 500 + turnWindow.minTurns: 2`，实测一页搬 300~1188 条、
  // 0.7~2.9 MB。
  //
  // 2026-11-20：改写默认关闭。理由见 lib/history-cap.js 顶部——客户端的
  // `native` 消费分支不做锚点补偿，只依赖 `overflow-anchor`，而该属性在
  // 滚动动效激活时被置为 `none`；两者叠加时改写页长会让内容跳动。
  // 现在这里只保留每页耗时/体积计时，回包原样透传。
  ctx.effect(
    () => installHistoryCap({
      sessionController: ctx.sessionController,
      pageEvents: config?.historyPageEvents,
      rewrite: config?.historyRewrite === true,
      diag,
    }),
    'session-firstpaint: history page cap',
  )
  // 分段计时补丁：只读计时，不改变任何行为，用来定位冷读的各段耗时。
  ctx.effect(
    () => installProfile({
      persistence: ctx.sessionPersistence,
      diag,
      thresholdMs: config?.profileThresholdMs,
    }),
    'session-firstpaint: cold-read profile',
  )
  // surface 快照计时：这些方法内部逐个 structuredClone 事件，
  // 采样显示累计 3893 ms，是首屏之后卡顿的主要嫌疑。
  ctx.effect(
    () => installQueryProbe({
      sessionQuery: ctx.sessionQuery,
      diag,
      thresholdMs: config?.profileThresholdMs,
    }),
    'session-firstpaint: query probe',
  )
  // 消除 snapshotLive 的全量深拷贝：实测一次 33 MB 会话要克隆 43950 个事件，
  // 花掉 1.4～2.2 秒、多占 418 MB 堆，而这些事件本来就是 deepFreeze 过的不可变值。
  ctx.effect(
    () => installFastLoad({ sessionQuery: ctx.sessionQuery, persistence: ctx.sessionPersistence, diag }),
    'session-firstpaint: shared load',
  )
  // 消除 sessionQuery 上两处纯浪费：
  // readSession 里被丢弃的 Session.create（3.1 s）与逐事件克隆（2.5 s）；
  // readEvent 每次全量 list 会话（每次 1.3 s，连续 5 次合计 6.5 s）。
  ctx.effect(
    () => installQueryFastPath({
      sessionQuery: ctx.sessionQuery,
      persistence: ctx.sessionPersistence,
      diag,
    }),
    'session-firstpaint: query fast path',
  )
  // 常驻卡顿归因：区分「GC 造成」还是「同步代码造成」。
  // CPU 采样改成一次性触发，不再常驻——上一版常驻采样器自激出 3.1 s 周期卡顿，
  // 原因见 lib/sample.js 顶部说明。
  ctx.effect(
    () => installGcWatch({
      diag,
      stallMs: config?.stallThresholdMs,
      gcMs: config?.gcThresholdMs,
      trail: readTrail,
    }),
    'session-firstpaint: stall attribution',
  )
  // 一次性采样：默认 30 s 后自动停，全程只采一次、只停一次。
  if (config?.sample === true) {
    ctx.effect(
      () => {
        void sampleOnce({
          diag,
          label: 'startup',
          windowMs: config?.sampleWindowMs,
          intervalUs: config?.sampleIntervalUs,
        })
        return () => {}
      },
      'session-firstpaint: one-shot sample',
    )
  }
  // 插件装载/重载时留一条记录，用来确认磁盘上的新代码确实被加载了。
  diag(`INSTALL maxMessages=${resolveMaxMessages(config)} segmented=yes stallWatch=yes profile=yes memo=${resolveMemoBudget(config) / 1048576}MB historyRewrite=${config?.historyRewrite === true ? 'on' : 'off'} sample=${config?.sample === true ? 'on' : 'off'}`)
}

/** 供离线自测读取的最近一次冷开时间，避免为测试导出内部状态。 */
export function lastColdOpen() {
  return { ...coldOpen }
}

