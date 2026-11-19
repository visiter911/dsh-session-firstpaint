/**
 * 消除 `SessionCorpus.load()` 在 **live 路径**上的全量深拷贝。
 *
 * ## 为什么
 *
 * 采样实测（一次性采样，stopCost 仅 102 ms，数据可信）：
 *   structuredClone 25.3 s / 100 s 窗口 —— 是第二大项 GC(9.5 s) 的 2.7 倍。
 *   最大调用者是 `snapshotSessionEvent`（`dsh-session`，3893 ms）。
 *
 * `load()` 的 live 路径：
 *
 *   live 路径   →  snapshotLive(session)
 *                  events: snapshotEvents().map(e => structuredClone(e))
 *
 * **原始事件本来就是不可变的**：
 *   - 落盘读取 `freezeStoredEvents()` 会 deepFreeze 每个事件，
 *     并把 eventState 标成 `shared-frozen`；
 *   - 实时追加 `createAppendEvent()` 也 deepFreeze 整个事件图；
 *   - `Session` 构造对 seed 同样 deepFreeze；
 *   - header 经 `validateSessionHeader()` 的 `deepFreeze(record)`。
 *
 * 所以对已经深冻结的值再 `structuredClone` 只是复制不可变数据。本模块只替换
 * live 路径：逐事件判断，冻结的共享引用，未冻结的才克隆（未冻结的是
 * `interruptedTurnClosers()` 补的合成 closer，通常只有 1~2 个）。
 *
 * ## 冷路径为什么完全不碰（重要）
 *
 * 早先这一版还接管了冷路径：自己 `persistence.open()` 一遍，想拿
 * `shared-frozen` 的事件来省掉克隆。线上 14 小时数据证明**这是净亏**：
 *
 *   - 宿主 `follow` → `observeSession` → `acquire` → `loadSource`
 *     那边**也会**独立 open + 解码一次；
 *   - `coldLogMemo` 上限只有 `COLD_LOG_MEMO_MAX_ENTRIES = 2`，
 *     并发/连续窗口里两次 open 都 miss，同一份日志被完整解码两遍。
 *
 *   实测代价：
 *     我的克隆节省      ~1369 ms（`PROFILE-READ read=1369ms events=48440`）
 *     我引入的重复解码  2918~8845 ms（同一会话 6 秒内 `PROFILE-OPEN` 三次）
 *     启动时 8 次 open 直接失败（`reasons=open-failed=8`），退回原实现又解一遍
 *
 * 所以冷路径现在一律交回原实现。共享只对**已经 live** 的会话做——
 * 那里 `snapshotEvents()` 已在手上，不额外付任何 I/O 与解码。
 *
 * ## 安全性
 *
 *   - 只在 live 路径动手，`:O(n)` 属性读取判定冻结，不改变语义；
 *   - 冷路径零改动，宿主行为与未装插件时一致；
 *   - 卸载即还原。
 */

/** 打补丁标记，避免热重载重复包装。 */
const PATCHED = Symbol.for('dsh.sessionFirstpaint.fastload')

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
 * 判断一个值是否已被深冻结（header 这种小对象用，全量遍历代价可忽略）。
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
 * 宿主的 `interruptedTurnClosers`。
 *
 * 冷路径需要自己给「未关闭的 turn」补合成 closer，语义必须与宿主一致，
 * 所以这里直接复用它的实现，不自己造。解析失败时保持 undefined，
 * 调用方据此退回原实现。
 */
let closersFn
let closersResolved = false

/**
 * 解析宿主 `@deepseek-ai/dsh-session` 的导出。
 *
 * 插件在宿主进程里运行，但该包不是本插件的依赖，所以按运行环境推导路径。
 * @returns {Promise<((events: readonly object[]) => object[]) | undefined>} 函数或 undefined。
 */
async function resolveClosers() {
  if (closersResolved) return closersFn
  closersResolved = true
  const candidates = []
  try {
    const mod = await import('@deepseek-ai/dsh-session')
    if (typeof mod?.interruptedTurnClosers === 'function') {
      closersFn = mod.interruptedTurnClosers
      return closersFn
    }
  } catch {
    // 裸包名解析不到，继续试绝对路径。
  }
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined
  if (resources !== undefined) {
    candidates.push(`${resources}/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`)
    candidates.push(`${resources}/app/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`)
  }
  const install = process.env.DSH_INSTALL_DIR
  if (typeof install === 'string' && install !== '') {
    candidates.push(`${install}/node_modules/@deepseek-ai/dsh-session/lib/index.js`)
    candidates.push(`${install}/../node_modules/@deepseek-ai/dsh-session/lib/index.js`)
  }
  for (const candidate of candidates) {
    try {
      const url = candidate.startsWith('file:') ? candidate : `file:///${candidate.replace(/\\/g, '/')}`
      const mod = await import(url)
      if (typeof mod?.interruptedTurnClosers === 'function') {
        closersFn = mod.interruptedTurnClosers
        return closersFn
      }
    } catch {
      // 这个候选不可用，试下一个。
    }
  }
  return undefined
}

/**
 * 安装共享式 `load()`。
 * @param {object} options - 安装参数。
 * @param {object} options.sessionQuery - `ctx.sessionQuery` 服务实例。
 * @param {object} options.persistence - `ctx.sessionPersistence`，冷路径要自己 open/read。
 * @param {(line: string) => void} options.diag - 输出。
 * @returns {() => void} 还原函数。
 */
export function installFastLoad({ sessionQuery, persistence, diag }) {
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
  // 冷路径已完全不接管，`interruptedTurnClosers` 不再需要。
  void resolveClosers
  closersResolved = true

  // 成功安装必须留证：没有这一行，升级后「补丁静默失效」会看起来和正常一样。
  diag(`FASTLOAD-ARMED SessionCorpus.load (live-only, cold=pass-through)`)

  /** 统计：live 命中次数与逐事件共享/克隆量。 */
  const stats = {
    liveHit: 0,
    sharedEvents: 0,
    clonedEvents: 0,
  }
  /**
   * 冷路径按原实现放行的次数。
   *
   * 这里不是「退回」而只是「不接管」——保留计数，
   * 便于确认冷路径确实没被本模块碰过。
   */
  let coldPassThrough = 0

  async function load(sessionId, signal) {
    signal?.throwIfAborted()
    const live = this._ctx?.sessions?.get(sessionId)

    if (live !== undefined) {
      const events = live.snapshotEvents()
      // 逐事件判定：冻结的共享，未冻结的克隆。
      // 不能要求全部冻结：live 会话也可能带 1~2 个未冻结的 closer，
      // 那会让整份 5 万事件退回 snapshotLive 的全量克隆（实测 shared=0）。
      let cloned = 0
      let shared = 0
      const mapped = events.map((event) => {
        if (event !== null && typeof event === 'object' && Object.isFrozen(event)) {
          shared += 1
          return event
        }
        cloned += 1
        return structuredClone(event)
      })
      stats.sharedEvents += shared
      stats.clonedEvents += cloned
      stats.liveHit += 1
      return {
        header: isDeeplyFrozen(live.header) ? live.header : structuredClone(live.header),
        inheritedEventCount: live.inheritedEventCount,
        events: mapped,
      }
    }

    // ---- 冷路径：不接管，直接放行 ----
    //
    // 上一版这里会自己 `persistence.open()` 一遍，想拿到 `shared-frozen`
    // 的事件来省掉一次克隆。线上数据证明这是净亏：
    //
    //   宿主 follow/observeSession 那边**也会**独立 open + 解码一次，
    //   而 `coldLogMemo` 上限只有 2 条，并发窗口里两次 open 都 miss，
    //   于是同一份日志被完整解码两遍。
    //
    //   实测代价（14 小时日志）：
    //     我的克隆节省      ~1369 ms  (PROFILE-READ read=1369ms events=48440)
    //     我引入的重复解码  2918~8845 ms（同一会话 6 秒内 open 三次）
    //     启动时 8 次 open 直接失败（reasons=open-failed=8），退回原实现又解一遍
    //
    // 所以冷路径一律交回原实现。共享只对**已经 live** 的会话做，
    // 那里 `snapshotEvents()` 已经在手上，不额外付任何 I/O。
    coldPassThrough += 1
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
    if (stats.liveHit === 0 && coldPassThrough === 0) return
    diag(
      `FASTLOAD live=${stats.liveHit}`
      + ` coldPassThrough=${coldPassThrough}`
      + ` shared=${stats.sharedEvents} cloned=${stats.clonedEvents}`,
    )
    stats.liveHit = 0
    coldPassThrough = 0
    stats.sharedEvents = 0
    stats.clonedEvents = 0
  }, 60_000)
  if (typeof timer.unref === 'function') timer.unref()

  return () => {
    clearInterval(timer)
    restore()
  }
}
