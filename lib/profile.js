/**
 * 冷读与 surface 快照的分段计时。
 *
 * 上一版有两个缺陷，本次一并修掉：
 *
 * 1. **量大错位置**：`open()` 内部就已经调用 `requireStoredLog()` 完成了解码，
 *    而我只计了 `handle.read()`；更糟的是 `handle.read` 会把该会话的累计值清零，
 *    所以线上看到的是 `decode=0ms io+verify=426ms`——解码根本没被计到。
 * 2. **漏掉首屏之后的大头**：采样归因显示 `structuredClone` 的最大调用者是
 *    `snapshotSessionEvent`（`dsh-session/lib/index.js`，3893 ms），
 *    它由 session-query 的 surface 读取方法调用，每次深拷贝整个事件。
 *
 * 现在计四个位置：
 *
 *   persistence.open            —— 含解码，冷开的真实入口
 *   persistence.requireStoredLog —— 解码子阶段（解压 + parse + 校验 + 冻结）
 *   persistence.readStoredLog    —— 更深一层（若被调用）
 *   <handle>.read                —— memo 命中后的读取
 *   sessionQuery.readSurface / readSession / readEvent / traceEvent
 *                                —— surface 快照，内部逐个 structuredClone
 *
 * 全部是运行时补丁：不改 asar、不改包、不改配置；卸载即还原。
 */

/** 打补丁标记，避免热重载重复包装。 */
const PATCHED = Symbol.for('dsh.sessionFirstpaint.profile')

/** 低于这个耗时就不记录，避免小会话刷屏。 */
const DEFAULT_THRESHOLD_MS = 200

/** 高精度时钟；宿主一定有 performance。 */
function now() {
  return performance.now()
}

/**
 * 在对象原型链上找到「自己拥有」指定方法的原型。
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
 * 取一个可读的类型名，用于诊断输出。
 * @param {unknown} value - 任意值。
 * @returns {string} 类型名。
 */
function typeName(value) {
  if (value === null || value === undefined) return String(value)
  try {
    return Object.getPrototypeOf(value)?.constructor?.name ?? typeof value
  } catch {
    return typeof value
  }
}

/**
 * 摘掉上一轮留下的还原函数（HMR 重载时旧 fiber 的 cleanup 可能永远不跑）。
 * @param {object | undefined} proto - 目标原型。
 */
function clearPrevious(proto) {
  const previous = proto?.[PATCHED]
  if (typeof previous !== 'function') return
  try {
    previous()
  } catch {
    // 旧补丁摘除失败不阻止新补丁安装。
  }
}

/**
 * 定义一个不可枚举的方法。
 * @param {object} proto - 目标原型。
 * @param {string} name - 方法名。
 * @param {Function} value - 新实现。
 */
function define(proto, name, value) {
  Object.defineProperty(proto, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  })
}

/**
 * 安装冷读分段计时。
 * @param {object} options - 安装参数。
 * @param {object} options.persistence - `ctx.sessionPersistence` 服务实例。
 * @param {(line: string) => void} options.diag - 诊断行输出（内存缓冲，不阻塞）。
 * @param {number | undefined} options.thresholdMs - 超过多少毫秒才记录。
 * @returns {() => void} 还原函数。
 */
export function installProfile({ persistence, diag, thresholdMs }) {
  const openProto = prototypeWith(persistence, 'open')
  if (openProto === undefined) {
    diag(`PROFILE-SKIP open-not-found on ${typeName(persistence)}`)
    return () => {}
  }

  clearPrevious(openProto)
  const storeProto = prototypeWith(persistence, 'requireStoredLog')
  clearPrevious(storeProto)
  const deepProto = prototypeWith(persistence, 'readStoredLog')
  clearPrevious(deepProto)

  const threshold = typeof thresholdMs === 'number' && thresholdMs > 0
    ? thresholdMs
    : DEFAULT_THRESHOLD_MS

  /**
   * 正在进行的 open 周期，按会话 id 关联。
   * 解码发生在 open 内部，所以只有 open 知道这次解码属于哪一轮。
   */
  const cycles = new Map()

  const originalOpen = openProto.open
  const originalRequire = storeProto?.requireStoredLog
  const deepReadable = typeof deepProto?.readStoredLog === 'function'
  const originalDeep = deepProto?.readStoredLog

  // ---- 解码子阶段：requireStoredLog ----
  async function timedRequire(id, signal) {
    const start = now()
    try {
      return await originalRequire.call(this, id, signal)
    } finally {
      const cycle = cycles.get(String(id))
      if (cycle !== undefined) cycle.decodeMs += now() - start
    }
  }

  // ---- 更深一层：readStoredLog（可能被 requireStoredLog 调用）----
  async function timedDeep(path, expectedId, signal) {
    const start = now()
    try {
      return await originalDeep.call(this, path, expectedId, signal)
    } finally {
      const cycle = cycles.get(String(expectedId))
      if (cycle !== undefined) cycle.deepMs += now() - start
    }
  }

  // ---- 主阶段：open ----
  async function timedOpen(id, access, options) {
    const key = String(id)
    const start = now()
    const heapBefore = process.memoryUsage().heapUsed
    const cycle = { decodeMs: 0, deepMs: 0, readMs: 0 }
    cycles.set(key, cycle)
    try {
      const handle = await originalOpen.call(this, id, access, options)
      return instrumentHandle(handle, key)
    } finally {
      cycles.delete(key)
      const totalMs = now() - start
      if (totalMs >= threshold) {
        const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1048576
        // 解码之外的都算「读文件 + 身份校验 + 组装」
        const ioMs = Math.max(0, totalMs - cycle.decodeMs)
        diag(
          `PROFILE-OPEN ${key}`
          + ` open=${totalMs.toFixed(0)}ms`
          + ` decode=${cycle.decodeMs.toFixed(0)}ms`
          + ` io+verify=${ioMs.toFixed(0)}ms`
          + (cycle.deepMs > 0 ? ` [readStoredLog=${cycle.deepMs.toFixed(0)}ms]` : '')
          + ` heap=${heapDeltaMb >= 0 ? '+' : ''}${heapDeltaMb.toFixed(0)}MB`,
        )
      }
    }
  }

  /**
   * 给一个 handle 的 read 装计时；解码已计入 open，这里只报 memo 读取。
   * @param {object} handle - `open()` 返回的会话句柄。
   * @param {string} key - 会话 id。
   * @returns {object} 同一个 handle。
   */
  function instrumentHandle(handle, key) {
    if (handle === null || typeof handle !== 'object') return handle
    if (typeof handle[PATCHED] === 'function') return handle
    const originalRead = handle.read
    if (typeof originalRead !== 'function') return handle

    function timedRead(offset, length, options) {
      const start = now()
      const isFullRead = (offset ?? 0) === 0
        && (length === undefined || length === Number.MAX_SAFE_INTEGER)
      let result
      try {
        result = originalRead.call(this, offset, length, options)
      } catch (error) {
        throw error
      }
      if (result === null || typeof result !== 'object' || typeof result.then !== 'function') return result
      return result.then((value) => {
        if (isFullRead) {
          const totalMs = now() - start
          if (totalMs >= threshold) {
            diag(
              `PROFILE-READ ${key}`
              + ` read=${totalMs.toFixed(0)}ms`
              + ` events=${value?.events?.length ?? 0}`
              + ` state=${value?.eventState ?? '-'}`,
            )
          }
        }
        return value
      })
    }

    try {
      Object.defineProperty(handle, 'read', {
        value: timedRead,
        writable: true,
        configurable: true,
        enumerable: false,
      })
      Object.defineProperty(handle, PATCHED, { value: () => {}, configurable: true })
    } catch {
      // 句柄不可写时放弃：计时失败不影响读取。
    }
    return handle
  }

  define(openProto, 'open', timedOpen)
  define(openProto, PATCHED, () => {
    if (openProto.open !== timedOpen) return
    define(openProto, 'open', originalOpen)
    if (typeof originalRequire === 'function' && storeProto.requireStoredLog === timedRequire) {
      define(storeProto, 'requireStoredLog', originalRequire)
    }
    if (deepReadable && deepProto.readStoredLog === timedDeep) {
      define(deepProto, 'readStoredLog', originalDeep)
    }
    delete openProto[PATCHED]
    cycles.clear()
  })
  if (typeof originalRequire === 'function') define(storeProto, 'requireStoredLog', timedRequire)
  if (deepReadable) define(deepProto, 'readStoredLog', timedDeep)

  diag(
    `PROFILE-ARMED open${typeof originalRequire === 'function' ? ' + requireStoredLog' : ''}`
    + `${deepReadable ? ' + readStoredLog' : ''} on ${typeName(persistence)}`,
  )
  return openProto[PATCHED]
}

/**
 * 给 session-query 的 surface 读取装计时。
 *
 * 这些方法内部逐个调用 `snapshotSessionEvent()`，而它的实现是
 * `adoptSessionEvent(structuredClone(event))`——每个事件一次深拷贝。
 * 采样显示这一项累计 3893 ms，是首屏之后卡顿的主要嫌疑。
 *
 * @param {object} options - 安装参数。
 * @param {object} options.sessionQuery - `ctx.sessionQuery` 服务实例。
 * @param {(line: string) => void} options.diag - 诊断行输出。
 * @param {number | undefined} options.thresholdMs - 超过多少毫秒才记录。
 * @returns {() => void} 还原函数。
 */
export function installQueryProbe({ sessionQuery, diag, thresholdMs }) {
  const proto = prototypeWith(sessionQuery, 'readSurface')
    ?? prototypeWith(sessionQuery, 'readSession')
  if (proto === undefined) {
    diag(`QUERY-SKIP readSurface/readSession not found on ${typeName(sessionQuery)}`)
    return () => {}
  }

  clearPrevious(proto)

  const threshold = typeof thresholdMs === 'number' && thresholdMs > 0
    ? thresholdMs
    : DEFAULT_THRESHOLD_MS

  /** 待包装的方法名：都会走 snapshotSessionEvent 的逐个克隆。 */
  const METHODS = ['readSurface', 'readSession', 'readEvent', 'traceEvent', 'listEvents', 'listSessions']
  const installed = []

  for (const method of METHODS) {
    const own = prototypeWith(sessionQuery, method)
    if (own === undefined || typeof own[method] !== 'function') continue
    const original = own[method]

    function timed(...args) {
      const start = now()
      const result = original.apply(this, args)
      if (result === null || typeof result !== 'object' || typeof result.then !== 'function') {
        report(method, start, undefined, threshold, diag)
        return result
      }
      return result.then(
        (value) => {
          report(method, start, value, threshold, diag)
          return value
        },
        (error) => {
          report(method, start, undefined, threshold, diag, true)
          throw error
        },
      )
    }

    define(own, method, timed)
    installed.push({ proto: own, method, original })
  }

  if (installed.length === 0) {
    diag(`QUERY-SKIP no methods installed on ${typeName(sessionQuery)}`)
    return () => {}
  }

  diag(`QUERY-ARMED ${installed.map(item => item.method).join('/')}`)

  /** 还原。 */
  function restore() {
    for (const item of installed) {
      if (item.proto[item.method] === item.original) continue
      define(item.proto, item.method, item.original)
    }
    delete proto[PATCHED]
  }

  proto[PATCHED] = restore
  return restore
}

/**
 * 输出一次 query 方法调用的耗时。
 * @param {string} method - 方法名。
 * @param {number} start - 起始时刻。
 * @param {unknown} value - 返回值。
 * @param {number} threshold - 阈值。
 * @param {(line: string) => void} diag - 输出。
 * @param {boolean | undefined} failed - 是否以异常结束。
 */
function report(method, start, value, threshold, diag, failed) {
  try {
    const totalMs = now() - start
    if (totalMs < threshold) return
    const count = Array.isArray(value?.events) ? value.events.length : undefined
    diag(
      `QUERY ${method} ${totalMs.toFixed(0)}ms`
      + (count === undefined ? '' : ` events=${count}`)
      + (failed === true ? ' failed' : ''),
    )
  } catch {
    // 诊断失败不影响读取。
  }
}
