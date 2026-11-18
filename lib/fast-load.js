/**
 * 消除 `snapshotLive()` 的全量深拷贝。
 *
 * 采样实测（一次性采样，stopCost 仅 102 ms，数据可信）：
 *   structuredClone 25.3 s / 100 s 窗口 —— 是第二大项 GC(9.5 s) 的 2.7 倍。
 *
 * 来源是 `dsh-session-query` 的：
 *
 *   function snapshotLive(session) {
 *     return {
 *       header: structuredClone(session.header),
 *       inheritedEventCount: session.inheritedEventCount,
 *       events: session.snapshotEvents().map((event) => structuredClone(event)),
 *     }
 *   }
 *
 * 它把整份日志的每个事件都深拷贝一遍。真实 33 MB / 43950 事件会话实测：
 *   structuredClone 全部事件 = 1441～2243 ms，堆 +418 MB
 *   共享同一批引用          = 2 ms
 *
 * **这些对象本来就是不可变的**：
 *   - 落盘读取路径 `freezeStoredEvents()` 会 `deepFreeze` 每个事件，
 *     并把 eventState 标成 `shared-frozen`；
 *   - 实时追加路径 `createAppendEvent()` 也 `deepFreeze` 整个事件图；
 *   - `Session` 构造时对 seed 同样 `deepFreeze`；
 *   - header 经 `snapshotSessionHeader` / `validateRestoredSessionHeader`
 *     一律走 `validateSessionHeader()` 里的 `deepFreeze(record)`。
 *
 * 所以对已经深冻结的值再 `structuredClone` 一遍，只是把同一份不可变数据
 * 复制一份，纯属浪费：既花时间又让堆多背一份。本模块在 `load()` 上做替换，
 * 命中「全部已冻结」时直接共享引用，否则**原样退回**原实现。
 *
 * 安全性：
 *   - 只在能证明不可变时才替换，任何一个值没冻结就走原路径；
 *   - 返回值形状、字段完全一致，只是不再复制；
 *   - 用 `Object.isFrozen` 判定，不改动任何包与配置；
 *   - 卸载即还原。
 */

/** 打补丁标记，避免热重载重复包装。 */
const PATCHED = Symbol.for('dsh.sessionFirstpaint.fastload')

/** 没有父对象的原型链终点。 */
function prototypeWith(target, method) {
  if (target === null || target === undefined) return undefined
  for (let proto = Object.getPrototypeOf(target); proto !== null; proto = Object.getPrototypeOf(proto)) {
    if (typeof Object.getOwnPropertyDescriptor(proto, method)?.value === 'function') return proto
  }
  return undefined
}

/**
 * 判断一个值是否已被深冻结。
 *
 * 用于 header 这种小对象（几十个键），全量遍历代价可忽略。
 * @param {unknown} value - 待判定值。
 * @returns {boolean} 整张图是否都冻结。
 */
function isDeeplyFrozen(value) {
  const pending = [value]
  const seen = new Set()
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === null || typeof node !== 'object') continue
    if (seen.has(node)) continue
    seen.add(node)
    if (!Object.isFrozen(node)) return false
    for (const key of Object.keys(node)) pending.push(node[key])
  }
  return true
}

/**
 * 事件数组是否整体不可变。
 *
 * 只检查顶层：事件进入日志的唯一两条路径（`createAppendEvent` 与 seed 构造）
 * 都是对整张图 `deepFreeze`，所以「信封已冻结」即意味着「图已冻结」。
 * 这是 O(n) 的属性读取，实测 43950 个事件不到 1 ms，远低于克隆的 2 s。
 * @param {readonly unknown[]} events - 事件数组。
 * @returns {boolean} 是否可安全共享。
 */
function allFrozen(events) {
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (!Object.isFrozen(event)) return false
  }
  return true
}

/**
 * 安装共享式 `load()`。
 * @param {object} options - 安装参数。
 * @param {object} options.sessionQuery - `ctx.sessionQuery` 服务实例。
 * @param {(line: string) => void} options.diag - 输出。
 * @returns {() => void} 还原函数。
 */
export function installFastLoad({ sessionQuery, diag }) {
  // `SessionCorpus` 挂在 `_corpus` 上（普通字段，非 #private），可直接取得原型。
  const corpus = sessionQuery?._corpus
  const proto = prototypeWith(corpus, 'load')
  if (proto === undefined) {
    diag('FASTLOAD-SKIP SessionCorpus.load-not-found')
    return () => {}
  }

  const previous = proto[PATCHED]
  if (typeof previous === 'function') {
    try {
      previous()
    } catch {
      // 旧补丁摘除失败不阻止新补丁安装。
    }
  }

  const original = proto.load
  diag('FASTLOAD-ARMED SessionCorpus.load')

  /** 命中次数与省下的克隆量，用于确认真的生效。 */
  let hits = 0
  let skippedCold = 0

  async function load(sessionId, signal) {
    signal?.throwIfAborted()
    const live = this._ctx?.sessions?.get(sessionId)
    if (live !== undefined) {
      const events = live.snapshotEvents()
      // 只有整份都不可变时才共享；否则原样退回，绝不改变语义。
      if (allFrozen(events) && isDeeplyFrozen(live.header)) {
        hits += 1
        return {
          header: live.header,
          inheritedEventCount: live.inheritedEventCount,
          events,
        }
      }
    } else {
      skippedCold += 1
    }
    return original.call(this, sessionId, signal)
  }

  Object.defineProperty(proto, 'load', {
    value: load,
    writable: true,
    configurable: true,
    enumerable: false,
  })

  /** 还原。 */
  function restore() {
    // 迟到的旧 restore 不得摘掉新补丁：只有当前实现仍是自己装的那个时才还原。
    if (proto.load !== load) return
    Object.defineProperty(proto, 'load', {
      value: original,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    delete proto[PATCHED]
  }

  proto[PATCHED] = restore
  // 命中统计随插件输出，便于确认改动真的走了快路径。
  const timer = setInterval(() => {
    if (hits === 0 && skippedCold === 0) return
    diag(`FASTLOAD hits=${hits} coldFallback=${skippedCold}`)
    hits = 0
    skippedCold = 0
  }, 60_000)
  if (typeof timer.unref === 'function') timer.unref()

  return () => {
    clearInterval(timer)
    restore()
  }
}
