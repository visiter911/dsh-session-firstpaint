/**
 * 消除 sessionQuery 上两处纯浪费（实测合计省 5.6 s + 每次 1.3 s）。
 *
 * ## 一、`readSession` 的两处浪费
 *
 * 原始实现（`dsh-session-query/lib/index.js`）：
 *
 *   async readSession(sessionId) {
 *     const loaded = await this._corpus.load(sessionId)
 *     Session.create(sessionId, loaded.events, loaded.header, ...)   // ← 结果直接丢弃
 *     return {
 *       session: structuredClone(loaded.header),
 *       inheritedEventCount: loaded.inheritedEventCount,
 *       events: loaded.events.map(snapshotSessionEvent)              // ← 每个事件深拷贝
 *     }
 *   }
 *
 * 真实 55.3 MB / 64340 事件会话离线实测：
 *   Session.create（结果没人用）      3087 ms
 *   events.map(snapshotSessionEvent)  2529 ms
 *   直接返回已冻结引用                   0 ms
 *
 * 线上日志同一条会话 `QUERY readSession 8479ms events=48841`，
 * 减去 load 开销正好对上。唯一消费者是 `dsh-session-log-export`，
 * 它只把 events 交给 `formatSessionMarkdown()` 做只读格式化，不修改事件。
 *
 * 事件本身已经深冻结（落盘路径 `freezeStoredEvents` / 追加路径
 * `createAppendEvent` 都做 `deepFreeze`），所以再克隆一遍只是复制不可变数据。
 *
 * ## 二、`readEvent` 每次全量列会话
 *
 * `SessionCorpus.load` 的冷路径里写着：
 *
 *   const listed = (await listPersisted(persistence, signal))
 *     .find(snapshot => snapshot.header.id === sessionId)
 *
 * `listPersisted` 会扫目录并对**每个**会话 `stat` 一次（实测 1327 ms），
 * 只为从里面挑出 1 个。线上连续 5 次 `readEvent` 各花 2～3 秒，正是这个开销。
 *
 * 这里给 `persistence.list()` 加一个很短的 TTL 缓存（默认 2 s）：
 * 连续操作共享同一份列表，稍后自然过期，不改变任何可见语义。
 *
 * 全部是运行时补丁：不改 asar、不改包、不改配置；卸载即还原。
 */

/** 打补丁标记，避免热重载重复包装。 */
const PATCHED = Symbol.for('dsh.sessionFirstpaint.queries')

/**
 * 列表缓存存活时间（毫秒）。
 *
 * 之前是 2 秒，但实测 `persistence.list` 单次就要 800 ms~19 s（约 1000 个会话），
 * 而调用方（`load` → `listPersisted`）**总是**带 signal，2 秒窗口几乎撞不上。
 * 15 秒能覆盖一次「打开会话 + 读事件 + 切下一个」的连续操作。
 * 代价：新建/归档会话后的列表刷新最多滞后 15 秒。
 */
const DEFAULT_LIST_TTL_MS = 15_000

/** 单次 persistence.list 超过这个耗时才记录。 */
const LIST_SLOW_MS = 300

/**
 * 全进程共享的列表耗时累计，用来在 `listSessions` 内做减法：
 * 「总耗时 − 列表耗时 = 克隆 + 排序」的耗时。
 */
const listStats = { calls: 0, costMs: 0 }

/**
 * 捕获调用栈，认出「是谁在调这个方法」。
 *
 * 这些查询方法被多个包调用，只看总耗时分不清是谁在触发。
 * 取栈里第一个不属于本插件、也不属于 session-query 自身业务的方法名。
 * @param {string[]} skip - 需要跳过的包名片段。
 * @returns {string} 调用者描述，认不出返回 `unknown`。
 */
function callerOf(skip) {
  const start = new Error().stack
  if (typeof start !== 'string') return 'unknown'
  const lines = start.split('\n').slice(1)
  for (const line of lines) {
    if (!line.includes(' at ')) continue
    // 形如 `at methodName (file:///.../dsh-xxx/lib/index.js:123:45)`
    const match = /\s+at\s+(?:async\s+)?([^\s(]+)\s*(?:\((.+)\))?/.exec(line)
    if (match === null) continue
    let name = match[1] ?? ''
    let file = match[2] ?? ''
    // 无括号形式是 `at file:///path:line:col`，名字位置放的就是路径。
    if (file === '' && /[\\/]|\.m?js/.test(name)) {
      file = name
      name = ''
    }
    const haystack = `${name} ${file}`
    if (/session-firstpaint/.test(haystack)) continue
    if (skip.some(part => haystack.includes(part))) continue
    // 文件路径压缩成最后 3 段，便于一眼认出是谁。
    let short = ''
    if (file !== '') {
      const clean = file.replace(/^file:\/\/\/?/, '').replace(/^.*?node_modules[\\/]/, '')
      short = clean.split(/[\\/]/).filter(Boolean).slice(-3).join('/')
    }
    if (short !== '' && name !== '') return `${name}@${short}`
    return short !== '' ? short : name
  }
  return 'unknown'
}

/**
 * 毫秒时钟。
 * @returns {number} 当前毫秒。
 */
function nowMs() {
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
 * 判断一组值是否全部可安全共享（顶层已冻结）。
 *
 * 事件进入日志的两条路径都对整张图 `deepFreeze`，所以信封冻结即可共享。
 * @param {readonly unknown[]} values - 待检查的值。
 * @returns {boolean} 是否全部满足。
 */
function allFrozen(values) {
  for (const value of values) {
    if (value === null || typeof value !== 'object') continue
    if (!Object.isFrozen(value)) return false
  }
  return true
}

/**
 * 判断一个值是否已被深冻结（小对象用，例如 header）。
 * @param {unknown} value - 待检查的值。
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
 * 取宿主的 `snapshotSessionEvent`。
 *
 * 插件在宿主进程里运行，但 `@deepseek-ai/dsh-session` 不是本插件的依赖，
 * 所以先试裸包名（宿主解析器可能认得），再试从运行环境推导的绝对路径。
 * 全部失败返回 undefined —— 调用方据此退回「照旧全量克隆」，绝不改变语义。
 * @returns {Promise<((event: object) => object) | undefined>} 快照函数。
 */
async function resolveSnapshotEvent() {
  try {
    const mod = await import('@deepseek-ai/dsh-session')
    if (typeof mod?.snapshotSessionEvent === 'function') return mod.snapshotSessionEvent
  } catch {
    // 裸包名解析不到，继续试绝对路径。
  }
  const roots = []
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined
  if (resources !== undefined) {
    roots.push(`${resources}/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`)
    roots.push(`${resources}/app/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`)
  }
  const install = process.env.DSH_INSTALL_DIR
  if (typeof install === 'string' && install !== '') {
    roots.push(`${install}/node_modules/@deepseek-ai/dsh-session/lib/index.js`)
    roots.push(`${install}/../node_modules/@deepseek-ai/dsh-session/lib/index.js`)
  }
  for (const candidate of roots) {
    try {
      const url = candidate.startsWith('file:') ? candidate : `file:///${candidate.replace(/\\/g, '/')}`
      const mod = await import(url)
      if (typeof mod?.snapshotSessionEvent === 'function') return mod.snapshotSessionEvent
    } catch {
      // 这个候选路径不可用，试下一个。
    }
  }
  return undefined
}

/**
 * 安装 sessionQuery 的两处优化。
 * @param {object} options - 安装参数。
 * @param {object} options.sessionQuery - `ctx.sessionQuery` 服务实例。
 * @param {object} options.persistence - `ctx.sessionPersistence` 服务实例。
 * @param {(line: string) => void} options.diag - 输出。
 * @returns {() => void} 还原函数。
 */
export function installQueryFastPath({ sessionQuery, persistence, diag }) {
  const restores = []

  /** 异步解析宿主的 snapshotSessionEvent；解析完成后补丁才启用共享快路径。 */
  let originalSnapshotEvent
  const ready = resolveSnapshotEvent().then((fn) => {
    originalSnapshotEvent = fn
    if (fn === undefined) diag('QUERYFAST-WARN snapshotSessionEvent 未找到，readSession 将全量克隆')
    else diag('QUERYFAST-READY snapshotSessionEvent 已就绪')
  })

  // ---- 一、readSession：跳过被丢弃的 Session.create 与逐事件克隆 ----
  const queryProto = prototypeWith(sessionQuery, 'readSession')
  if (queryProto === undefined) {
    diag('QUERYFAST-SKIP readSession-not-found')
  } else {
    const previous = queryProto[PATCHED]
    if (typeof previous === 'function') {
      try {
        previous()
      } catch {
        // 旧补丁摘除失败不阻止新补丁安装。
      }
    }

    const originalReadSession = queryProto.readSession
    /** 统计：共享了多少事件、克隆了多少事件。 */
    const stats = { calls: 0, sharedEvents: 0, clonedEvents: 0, costMs: 0 }

    /**
     * 与 `snapshotSessionEvent(event)` 等价，但对已冻结的事件直接复用。
     *
     * `snapshotSessionEvent` = `adoptSessionEvent(structuredClone(event))`：
     * 先深拷贝，再校验信封 / surface 元数据 / 消息形状，最后 `deepFreeze`
     * 被识别出来的消息。事件进入日志的两条路径（落盘读取的
     * `freezeStoredEvents`、实时追加的 `createAppendEvent`）都已经做过
     * `deepFreeze`，所以对这类事件再拷贝一遍只是复制不可变数据。
     *
     * 判定标准取最保守的一条：**事件本身已冻结**。冻结即意味着这条
     * 不可变事件不可能再被就地修改，共享它不改变任何可见语义。
     * 未冻结的事件（冷读时追加的合成 turn closer 等）仍走完整克隆。
     * @param {object} event - 一个事件。
     * @returns {object} 可直接交给调用方的事件。
     */
    function adoptEvent(event) {
      if (event !== null && typeof event === 'object' && Object.isFrozen(event)) {
        stats.sharedEvents += 1
        return event
      }
      stats.clonedEvents += 1
      return originalSnapshotEvent(event)
    }

    async function readSession(sessionId) {
      const start = nowMs()
      // 认调用者：这些方法被多个包共用，只看耗时分不清是谁触发的。
      const caller = callerOf(['dsh-session-query', 'dsh-api-session-controller', 'dsh-typert'])
      // 等解析完成，确保快路径启用时 snapshotSessionEvent 一定可用。
      await ready
      const loaded = await this._corpus.load(sessionId)
      const loadMs = nowMs() - start
      if (originalSnapshotEvent === undefined) {
        // 拿不到 snapshotSessionEvent 就不能安全地跳过校验，原样退回。
        stats.clonedEvents += 1
        return originalReadSession.call(this, sessionId)
      }

      // 只 load 一次：自己完成映射，绝不二次调用原实现（那会再扫一遍全部会话）。
      const events = loaded.events.map(adoptEvent)
      stats.calls += 1
      const totalMs = nowMs() - start
      stats.costMs += totalMs

      if (totalMs >= 300) {
        diag(
          `READSESSION ${totalMs.toFixed(0)}ms load=${loadMs.toFixed(0)}ms`
          + ` events=${events.length} shared=${stats.sharedEvents}`
          + ` by=${caller}`,
        )
      }
      return {
        session: structuredClone(loaded.header),
        inheritedEventCount: loaded.inheritedEventCount,
        events,
      }
    }

    Object.defineProperty(queryProto, 'readSession', {
      value: readSession,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    diag('QUERYFAST-ARMED readSession (single load, shared frozen events)')

    // 每分钟汇总一次：共享/克隆比例是判断补丁是否生效的唯一可靠指标。
    const sessionTimer = setInterval(() => {
      if (stats.calls === 0) return
      diag(
        `READSESSION-STAT calls=${stats.calls}`
        + ` shared=${stats.sharedEvents} cloned=${stats.clonedEvents}`
        + ` avg=${(stats.costMs / stats.calls).toFixed(0)}ms`,
      )
      stats.calls = 0
      stats.sharedEvents = 0
      stats.clonedEvents = 0
      stats.costMs = 0
    }, 60_000)
    if (typeof sessionTimer.unref === 'function') sessionTimer.unref()

    restores.push(() => {
      clearInterval(sessionTimer)
      if (queryProto.readSession !== readSession) return
      Object.defineProperty(queryProto, 'readSession', {
        value: originalReadSession,
        writable: true,
        configurable: true,
        enumerable: false,
      })
      delete queryProto[PATCHED]
    })
  }

  // ---- 二、persistence.list：短 TTL 缓存，合并同一批连续读取 ----
  const listProto = prototypeWith(persistence, 'list')
  if (listProto === undefined) {
    diag('QUERYFAST-SKIP persistence.list-not-found')
  } else {
    const originalList = listProto.list
    let cached
    let cachedAt = 0
    let hits = 0
    let calls = 0
    let costMs = 0

    async function list(options) {
      const signal = options?.signal
      // 取消语义先照原样传达：已取消的调用绝不能拿到缓存结果。
      signal?.throwIfAborted()
      const now = Date.now()
      if (cached !== undefined && now - cachedAt < DEFAULT_LIST_TTL_MS) {
        hits += 1
        return cached
      }
      calls += 1
      // 认调用者：list 被反复调用（几十次/分钟），必须查清是谁在轮询。
      const caller = callerOf([
        'dsh-session-query',
        'dsh-api-session-controller',
        'dsh-typert',
        'dsh-session-persistence',
      ])
      const start = Date.now()
      const result = await originalList.call(this, options)
      const cost = Date.now() - start
      costMs += cost
      listStats.calls += 1
      listStats.costMs += cost
      // 单次列表超过阈值就记一行：这是「耗在哪、谁在调」的直接证据。
      if (cost >= LIST_SLOW_MS) {
        diag(
          `LIST-SLOW persistence.list ${cost}ms`
          + ` sessions=${Array.isArray(result) ? result.length : '-'}`
          + ` by=${caller}`,
        )
      }
      cached = result
      cachedAt = Date.now()
      return result
    }

    Object.defineProperty(listProto, 'list', {
      value: list,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    diag(`QUERYFAST-ARMED persistence.list (ttl=${DEFAULT_LIST_TTL_MS}ms)`)

    const timer = setInterval(() => {
      if (hits === 0 && calls === 0) return
      diag(`QUERYFAST list calls=${calls} cacheHits=${hits} sumCost=${costMs}ms`)
      calls = 0
      hits = 0
      costMs = 0
    }, 60_000)
    if (typeof timer.unref === 'function') timer.unref()

    restores.push(() => {
      clearInterval(timer)
      if (listProto.list !== list) return
      Object.defineProperty(listProto, 'list', {
        value: originalList,
        writable: true,
        configurable: true,
        enumerable: false,
      })
      cached = undefined
    })
  }

  // ---- 三、listSessions 分段计时：14.5 秒到底花在哪 ----
  const listSessionsProto = prototypeWith(sessionQuery, 'listSessions')
  if (listSessionsProto !== undefined && typeof listSessionsProto.listSessions === 'function') {
    const originalListSessions = listSessionsProto.listSessions

    async function listSessions(signal) {
      const startTotal = nowMs()
      const callsBefore = listStats.calls
      const costBefore = listStats.costMs
      const result = await originalListSessions.call(this, signal)
      const total = nowMs() - startTotal
      if (total < LIST_SLOW_MS) return result
      // 列表本身的净耗时：总耗时减掉它，剩下的就是克隆 + 排序 + 等主线程。
      const listCost = listStats.costMs - costBefore
      const listCalls = listStats.calls - callsBefore
      void callsBefore
      const count = Array.isArray(result) ? result.length : 0
      diag(
        `LIST-SESSIONS total=${total.toFixed(0)}ms`
        + ` listCalls=${listCalls} listCost=${listCost.toFixed(0)}ms`
        + ` clone+sort=${Math.max(0, total - listCost).toFixed(0)}ms`
        + ` sessions=${count}`,
      )
      return result
    }

    Object.defineProperty(listSessionsProto, 'listSessions', {
      value: listSessions,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    diag('LIST-SESSIONS-ARMED listSessions')

    restores.push(() => {
      if (listSessionsProto.listSessions !== listSessions) return
      Object.defineProperty(listSessionsProto, 'listSessions', {
        value: originalListSessions,
        writable: true,
        configurable: true,
        enumerable: false,
      })
    })
  }

  return () => {
    for (const restore of restores) {
      try {
        restore()
      } catch {
        // 还原失败不影响其它项。
      }
    }
  }
}

