/**
 * 一次性 CPU 采样：只采一段、只停一次、绝不循环。
 *
 * 上一版采样器的设计有严重缺陷，实测把自己变成了卡顿源：
 * 日志里卡顿变成严格的 3.1 s 周期（`STALL 3190ms` → `CPU STALL` → `STALL 3195ms` …），
 * 这是采样器「start → 卡住 → stop → 再 start」自激的典型特征。
 * 而且 `Profiler.stop` 的代价随累计样本数增长，反复循环只会越来越慢。
 *
 * 本版改成：
 *   1. **一次性**：整个进程生命周期只采一次，采完就 `Profiler.disable` 并断开，
 *      不再重开，因此不存在自激循环；
 *   2. **粗间隔**：默认 10 ms 一个样本。要找的是秒级热点，
 *      10 ms 分辨率完全够用，样本数比 1 ms 少一个数量级，`stop` 也就便宜一个数量级；
 *   3. **有界窗口**：最多采 `windowMs`，到点自动停，不会无限累积；
 *   4. **自报开销**：明确测出 `Profiler.stop` 自己花了多久，
 *      如果它又很贵，日志会直接写出来，不用再猜。
 */

import inspector from 'node:inspector'

/** 默认采样间隔（微秒）。10 ms 足够定位秒级热点，样本数只有 1 ms 的 1/10。 */
const DEFAULT_INTERVAL_US = 10_000

/** 默认最长采样时长（毫秒）。 */
const DEFAULT_WINDOW_MS = 30_000

/**
 * 建立节点 id → 父节点 id 的映射。
 *
 * profile 只给了每个节点的 children，要反查「谁调用了它」必须自己建反向表。
 * @param {Array<object>} nodes - profile.nodes。
 * @returns {Map<number, number>} 子 → 父。
 */
function buildParentMap(nodes) {
  const parent = new Map()
  for (const node of nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id)
  }
  return parent
}

/**
 * 取某个节点的可读名字。
 * @param {Map<number, object>} byId - id → 节点。
 * @param {number} id - 节点 id。
 * @returns {string} `函数名 @ 路径`。
 */
function nameOf(byId, id) {
  const frame = byId.get(id)?.callFrame
  if (frame === undefined) return '(unknown)'
  const name = frame.functionName === '' ? '(anonymous)' : frame.functionName
  const url = typeof frame.url === 'string' && frame.url !== ''
    ? frame.url.split(/[\\/]/).filter(Boolean).slice(-3).join('/')
    : ''
  return url === '' ? name : `${name} @ ${url}`
}

/** 原生克隆/遍历函数的样本必须归因到它的调用者，否则永远只看到它自己。 */
const OPAQUE = /\bstructuredClone\b|\bwalkJsonValue\b|\bassign\b|\bhasIntrinsicConstructor\b|\bdeepFreeze\b/

/**
 * 把指定热点的样本按「第一个非原生祖先」再聚合一次。
 *
 * `structuredClone` 是原生函数，profile 只会把耗时记在它名下，
 * 完全看不出是哪一行代码在克隆。顺着 parent 链往上找到第一个业务函数，
 * 就能定位真正的调用点。
 * @param {object} profile - `Profiler.stop` 的 profile。
 * @param {string} targetName - 要归因的热点函数名（如 structuredClone）。
 * @returns {Array<{ name: string, ms: number }>} 调用者排行。
 */
function callerBreakdown(profile, targetName) {
  const byId = new Map()
  for (const node of profile.nodes) byId.set(node.id, node)
  const parent = buildParentMap(profile.nodes)

  const deltas = profile.timeDeltas ?? []
  const perCaller = new Map()
  for (let index = 0; index < profile.samples.length; index += 1) {
    const id = profile.samples[index]
    const frame = byId.get(id)?.callFrame
    if (frame === undefined) continue
    if (!(frame.functionName === targetName)) continue
    // 沿父链跳过所有原生/纯工具函数，落到第一个业务函数。
    let cursor = parent.get(id)
    let guard = 0
    while (cursor !== undefined && guard < 40) {
      const name = nameOf(byId, cursor)
      if (!OPAQUE.test(name)) break
      cursor = parent.get(cursor)
      guard += 1
    }
    const key = cursor === undefined ? '(top-level)' : nameOf(byId, cursor)
    perCaller.set(key, (perCaller.get(key) ?? 0) + (deltas[index] ?? 0))
  }

  return [...perCaller.entries()]
    .map(([name, micros]) => ({ name, ms: micros / 1000 }))
    .filter(item => item.ms >= 10)
    .sort((left, right) => right.ms - left.ms)
}

/**
 * 整份 profile 里各函数按自身耗时聚合后的排行。 */
function rankSelfTime(profile) {
  const byId = new Map()
  for (const node of profile.nodes) byId.set(node.id, node)

  const self = new Map()
  const deltas = profile.timeDeltas ?? []
  for (let index = 0; index < profile.samples.length; index += 1) {
    const node = byId.get(profile.samples[index])
    const frame = node?.callFrame
    if (frame === undefined) continue
    const name = frame.functionName === '' ? '(anonymous)' : frame.functionName
    // 保留最后 3 段：`包名/lib/index.js` 才能区分不同包的同名文件。
    // 只留 2 段会退化成 `lib/index.js`，多个包撞在一起就没法归因了。
    const url = typeof frame.url === 'string' && frame.url !== ''
      ? frame.url.split(/[\\/]/).filter(Boolean).slice(-3).join('/')
      : ''
    const key = url === '' ? name : `${name} @ ${url}`
    self.set(key, (self.get(key) ?? 0) + (deltas[index] ?? 0))
  }

  return [...self.entries()]
    .map(([name, micros]) => ({ name, ms: micros / 1000 }))
    // 空闲与调度器不是热点；GC 单独标注，不混进函数榜。
    .filter(item => item.ms >= 10
      && !item.name.startsWith('(idle)')
      && !item.name.startsWith('(program)'))
    .sort((left, right) => right.ms - left.ms)
}

/**
 * 采样一次并输出热点排行。采完即禁用，不会再次启动。
 * @param {object} options - 采样参数。
 * @param {(line: string) => void} options.diag - 输出。
 * @param {string} options.label - 日志里标注这次采样的触发原因。
 * @param {number | undefined} options.windowMs - 最长采样时长。
 * @param {number | undefined} options.intervalUs - 采样间隔（微秒）。
 * @returns {Promise<void>} 采样与输出完成后解决。
 */
export async function sampleOnce({ diag, label, windowMs, intervalUs }) {
  const limit = typeof windowMs === 'number' && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS
  const interval = typeof intervalUs === 'number' && intervalUs > 0 ? intervalUs : DEFAULT_INTERVAL_US

  const session = new inspector.Session()
  const post = (method, params) => new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })

  try {
    session.connect()
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval })
    const startedAt = Date.now()
    await post('Profiler.start')

    // 采够 windowMs 就停；到点前一直让出主线程，不产生额外负载。
    // 不加 unref：这个定时器必须保证触发，否则采样会永远不结束、
    // profiler 也永远不被停掉（正是上一版把自己拖住的根因之一）。
    await new Promise((resolve) => {
      setTimeout(resolve, limit)
    })

    const stopStart = Date.now()
    const { profile } = await post('Profiler.stop')
    // 这个数很关键：它就是上一版设计崩掉的原因，必须量化。
    const stopMs = Date.now() - stopStart
    const wallMs = Date.now() - startedAt

    const top = rankSelfTime(profile).slice(0, 8)
    const rendered = top.length === 0
      ? 'none'
      : top.map(item => `${item.name}:${item.ms.toFixed(0)}ms`).join(', ')
    diag(
      `SAMPLE ${label} wall=${wallMs}ms samples=${profile.samples.length}`
      + ` stopCost=${stopMs}ms interval=${interval / 1000}ms top=${rendered}`,
    )

    // 原生热点必须单独归因：只看自身耗时永远定位不到调用它的是哪一行。
    for (const target of ['structuredClone', 'walkJsonValue', 'deepFreeze']) {
      const callers = callerBreakdown(profile, target).slice(0, 6)
      if (callers.length === 0) continue
      diag(
        `CALLERS ${target} `
        + callers.map(item => `${item.name}:${item.ms.toFixed(0)}ms`).join(', '),
      )
    }
  } catch (error) {
    diag(`SAMPLE failed ${String(error)}`)
  } finally {
    try {
      await post('Profiler.disable')
    } catch {
      // 采样已经结束，disable 失败无关紧要。
    }
    try {
      session.disconnect()
    } catch {
      // 断开失败无关紧要。
    }
  }
}
