/**
 * 解码结果缓存扩容：把宿主的「固定 2 条」换成「字节预算 + LRU」。
 *
 * 动机（实测数据，2026-11-20）：
 *   宿主 `dsh-session-persistence-jsonl` 用 `coldLogMemo` 缓存已解码的会话，
 *   容量写死为 `COLD_LOG_MEMO_MAX_ENTRIES = 2`。缓存命中时重复打开只要 7 ms，
 *   未命中要重新走「解压 + 逐行 JSON.parse + 格式解码 + 深冻结」：
 *
 *     A=61.4MB  B=57.8MB  C=43.5MB
 *     1st A = 4374ms    1st B = 3555ms    2nd A = 7ms(命中)
 *     1st C = 2687ms    3rd A = 7ms       2nd B = 3329ms(被挤出)
 *
 *   两个位置在实际使用中不够：用户在 3~4 个长会话之间来回切换时，
 *   每切回来一次就要重新解码 2~4 秒。这是「打开会话要等 2 秒」的直接来源。
 *
 * CPU profile（开 4 个最大会话，采样 19219 ms）说明这段开销花在哪里：
 *   consumeEventLine 7726ms(40.2%) / decodeFrame 2957ms(15.4%)
 *   GC 1464ms(7.6%) / freezeStoredEvent 1144ms(6.0%) / utf8Slice 1049ms(5.5%)
 *   —— 全都是命中缓存时被完全省掉的。
 *
 * 每条缓存的内存代价（实测 heapUsed 差值）：
 *   61.4 MB / 78557 事件 → +356.7 MB
 *   57.8 MB / 66203 事件 → +293.3 MB
 *   约 4.6 KB/事件。
 *
 * 安全边界：
 *   - 只替换 `memoizeStoredLog` 的淘汰策略，不改任何事件内容、不做额外校验；
 *   - 缓存值仍是宿主自己产出的冻结对象，驱逐只是丢弃引用，消费者手上
 *     已有的引用不受影响（最多损失一次命中，不会读到旧内容）；
 *   - 键仍是会话 id，值仍带 `revision`，宿主的 `readStoredLog` 命中前
 *     照旧比对文件身份，文件一变就不复用；
 *   - 堆压力兜底：插入后若 `heapUsed` 超过高水位，立刻回收到半预算，
 *     避免把 4192 MB 的堆上限吃光。
 */

/** 默认预算：900 MB。约可容纳 4 个 40 MB 会话，或几十个中等会话。 */
const DEFAULT_BUDGET_BYTES = 900 * 1024 * 1024

/** 堆压力高水位：超过就立刻收缩，给宿主其余缓存留出余量。 */
const DEFAULT_HEAP_HIGH_WATER_BYTES = 2600 * 1024 * 1024

/** 每个事件驻留堆的实测估值（字节）。 */
const PER_EVENT_BYTES = 4600

/**
 * 在原型链上找到「自己拥有」指定方法的原型。
 * @param {object} target - 服务实例。
 * @param {string} method - 方法名。
 * @returns {object | undefined} 拥有该方法的原型对象。
 */
function prototypeWith(target, method) {
  if (target === null || target === undefined) return undefined
  for (let proto = Object.getPrototypeOf(target); proto !== null; proto = Object.getPrototypeOf(proto)) {
    if (typeof Object.getOwnPropertyDescriptor(proto, method)?.value === 'function') return proto
  }
  return undefined
}

/**
 * 收集原型链上每一层的「自有方法名」，用于诊断定位失败。
 * @param {object} target - 服务实例。
 * @returns {string[]} 每层一行描述。
 */
function describeChain(target) {
  const out = []
  let depth = 0
  for (let proto = Object.getPrototypeOf(target); proto !== null && depth < 8; proto = Object.getPrototypeOf(proto)) {
    const ctor = proto?.constructor?.name ?? '(anon)'
    const names = Object.getOwnPropertyNames(proto)
      .filter(name => typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function')
      .slice(0, 40)
    out.push(`${depth}:${ctor}[${names.join(',')}]`)
    depth += 1
  }
  return out
}

/**
 * 找到可以安全定义 `memoizeStoredLog` 的宿主对象。
 *
 * 热重载后实测出现过一次 `MEMOBUDGET-SKIP`，说明静态猜测原型链不够稳。
 * 这里按四档依次尝试，并且**以 `open` 所在的原型为主锚点**——`profile.js`
 * 用同一条 `prototypeWith(persistence, 'open')` 稳定命中，说明这个锚点是可靠的：
 *
 *   1. `open` 所在原型自己拥有 `memoizeStoredLog`（正常情况）
 *   2. 从 `open` 所在原型继续向上找 `memoizeStoredLog`
 *   3. 全链搜索 `memoizeStoredLog`
 *   4. 实例自身属性（宿主可能用箭头函数字段）
 *
 * @param {object} persistence - `ctx.sessionPersistence`。
 * @returns {{ host: object, how: string } | undefined} 可定义方法的对象与命中方式。
 */
function resolveHost(persistence) {
  if (persistence === null || persistence === undefined) return undefined

  const own = (obj, name) => typeof Object.getOwnPropertyDescriptor(obj, name)?.value === 'function'

  const openProto = prototypeWith(persistence, 'open')
  if (openProto !== undefined) {
    if (own(openProto, 'memoizeStoredLog')) return { host: openProto, how: 'open-proto' }
    for (let proto = Object.getPrototypeOf(openProto); proto !== null; proto = Object.getPrototypeOf(proto)) {
      if (own(proto, 'memoizeStoredLog')) return { host: proto, how: 'open-proto-up' }
    }
  }

  const anywhere = prototypeWith(persistence, 'memoizeStoredLog')
  if (anywhere !== undefined) return { host: anywhere, how: 'chain' }

  if (own(persistence, 'memoizeStoredLog')) return { host: persistence, how: 'own' }

  return undefined
}

/**
 * 估算一条缓存条目的驻留堆。
 * @param {object} stored - 宿主的已解码对象。
 * @returns {number} 估算字节数。
 */
function estimateBytes(stored) {
  const events = stored?.events
  const count = Array.isArray(events) ? events.length : 0
  return count * PER_EVENT_BYTES
}

/**
 * 安装解码缓存扩容。
 * @param {object} options - 安装参数。
 * @param {object} options.persistence - `ctx.sessionPersistence`。
 * @param {(line: string) => void} options.diag - 输出。
 * @param {number | undefined} options.budgetBytes - 缓存字节预算。
 * @param {number | undefined} options.heapHighWaterBytes - 堆压力高水位。
 * @returns {{ stop: Function, stats: Function }} 卸载与统计接口。
 */
export function installMemoBudget({
  persistence,
  diag,
  budgetBytes,
  heapHighWaterBytes,
}) {
  const resolved = resolveHost(persistence)
  if (resolved === undefined) {
    // 定位失败时把整条原型链打出来，下次不用再猜。
    const chain = persistence === null || persistence === undefined
      ? 'none'
      : describeChain(persistence).join(' | ')
    diag(`MEMOBUDGET-SKIP memoizeStoredLog-not-found chain=${chain}`)
    return { stop() {}, stats() { return {} } }
  }
  const proto = resolved.host

  const original = proto.memoizeStoredLog
  const budget = typeof budgetBytes === 'number' && budgetBytes > 0
    ? budgetBytes
    : DEFAULT_BUDGET_BYTES
  const highWater = typeof heapHighWaterBytes === 'number' && heapHighWaterBytes > 0
    ? heapHighWaterBytes
    : DEFAULT_HEAP_HIGH_WATER_BYTES

  /** id → 估算字节，与宿主 Map 同步维护。 */
  const sizes = new Map()
  let usedBytes = 0
  let evicted = 0
  let stored = 0
  let pressureSweeps = 0

  /**
   * 从队首按 LRU 淘汰，直到满足目标预算。
   * @param {Map} memo - 宿主的 coldLogMemo。
   * @param {number} target - 目标预算（字节）。
   */
  function evictTo(memo, target) {
    while (usedBytes > target && memo.size > 1) {
      const oldest = memo.keys().next().value
      if (oldest === undefined) break
      // 跳过刚插入的那一条（它在队尾，正常情况下不会被选到）。
      if (oldest === currentId) break
      const size = sizes.get(oldest) ?? 0
      memo.delete(oldest)
      sizes.delete(oldest)
      usedBytes -= size
      evicted += 1
    }
  }

  let currentId

  /**
   * 替换宿主的 memoizeStoredLog：同样的 Map 语义，换成字节预算淘汰。
   * @param {string} id - 会话 id。
   * @param {object} value - 宿主的已解码对象。
   */
  function memoizeStoredLog(id, value) {
    const memo = this.coldLogMemo
    if (!(memo instanceof Map)) {
      // 宿主内部结构变了：退回原实现，宁可少缓存也不要写坏。
      return original.call(this, id, value)
    }
    const size = estimateBytes(value)

    // 单条就超过整个预算的（例如 60 MB 会话）：照常放入，但只保留它自己，
    // 否则它会挤掉全部小会话，而那些小会话才是高频切换的对象。
    const previous = sizes.get(id)
    if (previous !== undefined) usedBytes -= previous
    memo.delete(id)
    memo.set(id, value)
    sizes.set(id, size)
    usedBytes += size
    stored += 1
    currentId = id

    evictTo(memo, budget)

    // 堆压力兜底：插入后立刻看一眼真实堆占用。
    try {
      const heapUsed = process.memoryUsage().heapUsed
      if (heapUsed > highWater && usedBytes > 0) {
        pressureSweeps += 1
        const before = usedBytes
        evictTo(memo, Math.floor(budget / 2))
        diag(
          `MEMOBUDGET-PRESSURE heap=${(heapUsed / 1048576).toFixed(0)}MB`
          + ` used=${(before / 1048576).toFixed(0)}MB`
          + ` after=${(usedBytes / 1048576).toFixed(0)}MB`,
        )
      }
    } catch {
      // memoryUsage 不可用（极少见）时不做兜底，不影响正确性。
    }
  }

  Object.defineProperty(proto, 'memoizeStoredLog', {
    value: memoizeStoredLog,
    writable: true,
    configurable: true,
    enumerable: false,
  })

  diag(
    `MEMOBUDGET-ARMED budget=${(budget / 1048576).toFixed(0)}MB`
    + ` highWater=${(highWater / 1048576).toFixed(0)}MB`
    + ` perEvent=${PER_EVENT_BYTES}B`
    + ` hostCap=2 via=${resolved.how}`,
  )

  return {
    /** 恢复宿主原实现。 */
    stop() {
      if (proto.memoizeStoredLog !== memoizeStoredLog) return
      Object.defineProperty(proto, 'memoizeStoredLog', {
        value: original,
        writable: true,
        configurable: true,
        enumerable: false,
      })
      sizes.clear()
      usedBytes = 0
    },
    /** 读取统计，供诊断输出。 */
    stats() {
      return {
        stored,
        evicted,
        pressureSweeps,
        usedBytes,
        entries: sizes.size,
        budget,
        highWater,
      }
    },
  }
}

/** 供外部读取的默认值。 */
export const MEMO_BUDGET_DEFAULTS = {
  budgetBytes: DEFAULT_BUDGET_BYTES,
  heapHighWaterBytes: DEFAULT_HEAP_HIGH_WATER_BYTES,
  perEventBytes: PER_EVENT_BYTES,
}
