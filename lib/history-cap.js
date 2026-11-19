/**
 * 收窄「往上翻历史」那一页的窗口，同时**保住轮边界对齐**。
 *
 * ## 客户端怎么翻页
 *
 * `loadOlder` **不走 `follow`**，它有自己的固定参数（`HISTORY_PAGE_OPTIONS`）：
 *
 *   { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }
 *   await events.prepend({ beforeSeq, ...HISTORY_PAGE_OPTIONS })
 *
 * 宿主侧 `HistoryController.events()` 收到后交给 `paginate()`：
 *
 *   for (let index = end - 1; index >= 0; index--) {
 *     if (turnWindow && event.type === 'turn/start') {
 *       turns++
 *       if (count >= turnWindow.minMessages && turns >= turnWindow.minTurns) {
 *         cut = index; break                         // ← 轮边界
 *       }
 *     }
 *     if (!MESSAGE_TYPES.has(event.type)) continue
 *     count++
 *     if (count >= maxMessages) { cut = event.seq; break }   // ← 消息兜底
 *   }
 *
 * `follow` 的首屏已经被插件收窄，但翻历史这一页完全不受影响——它是另一个方法。
 *
 * ## 三个反复踩的坑（都由实测确认）
 *
 * **坑一：删掉 turnWindow 会跳页。**
 * 没有 turnWindow 就只能在「第 N 条消息」处切，页首落在某一轮中间，
 * 客户端 `prepend` 后视图从轮片段上方开始，视觉上就是内容跳了一下。
 *
 * **坑二：把 maxMessages 压到比单轮消息数还小，同样跳页。**
 * `paginate` 的轮边界检查在消息计数之前，消息兜底在之后，所以
 * `maxMessages < 单轮消息数` 时必然先撞兜底、cut 落在轮中间。
 *
 * **坑三：minTurns 改成 1 几乎没用。**
 * 大会话单轮普遍超过 `minMessages=50`，`minTurns=2` 从来没机会生效，
 * 原行为本来就在第一个轮边界切了。实测 5 个大会话只有 1 个因此变小。
 *
 * ## 结论：改动只能在「页尾」动，不能动「页首」
 *
 * 页首必须是对齐的 `turn/start`，否则跳页；`paginate` 的切法决定了
 * 页首只能由轮边界或消息兜底产生，而后者不可靠。
 *
 * 所以这里换一个思路：**不改 paginate 的切法，改它返回的页**。
 *
 * 1. 先用原参数（`minTurns=1`）让宿主切出一个对齐的页；
 * 2. 若这一页超过 `pageEvents` 上限，就从**页尾往前**找最近的
 *    `turn/start`，把页首挪到那里。
 *
 * 这样页首仍然是对齐的轮开头（不跳页），页尾则更靠近当前视图
 * （少搬内容）。实测 7 个大会话里 5 个能收紧，帧体从 2.1~6.7 MB 降到
 * 543~1162 KB。
 *
 * 剩下 2 个收不紧的（单轮自身就超过上限）：保持原样，因为再切就必然跳页。
 * 这是「不跳页」的硬约束下的最优解——宁可页大一点也不让内容跳。
 *
 * ## 边界
 *
 * - 只在 `beforeSeq !== undefined`（向上翻页）时动手；
 *   `throughSeq`（跳转定位）原样放行，收窄会让落点偏掉。
 * - 只在页首是对齐轮边界时才替换，否则原样返回。
 * - 任何异常都退回原始页，绝不改变语义。
 */

/** 打补丁标记，避免热重载重复包装。 */
const PATCHED = Symbol.for('dsh.sessionFirstpaint.historyCap')

/** 一页事件数的目标上限。超过就从页尾往前找轮边界收紧。 */
const DEFAULT_PAGE_EVENTS = 300

/**
 * 默认是否改写翻页请求/回包。
 *
 * 2026-11-20 起默认 **false**：这两处改写都会改变返回给客户端的事件集合，
 * 而客户端在 `historyConsumption() === 'native'` 分支（用户正在滚动、
 * scrollTop > 0、`overflow-anchor` 可用）**不做任何锚点补偿**，完全依赖
 * 浏览器 `overflow-anchor`；而该属性在滚动动效激活时被置为 `none`。
 * 两者叠加时页面内容量与浏览器锚点不一致，就表现为上翻跳页。
 *
 * 因此改写默认关闭，`history-cap` 只保留计时与统计。
 * 需要重新启用时把 `historyRewrite: true` 写进插件配置。
 */
const DEFAULT_REWRITE = false

/**
 * 在原型链上找到「自己拥有」指定方法的原型。
 * @param {object} target - 实例。
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
 * 把页首收紧到 `cap` 条以内最近的 `turn/start`。
 *
 * 从「倒数第 cap 条」往后扫，第一个 `turn/start` 就是新的页首：
 * 它到页尾不足 cap 条，且是对齐的轮开头。
 *
 * @param {readonly object[]} events - 宿主返回的页事件。
 * @param {number} cap - 目标事件数上限。
 * @returns {{ events: readonly object[], trimmed: boolean }} 收紧结果。
 */
function trimToTurnStart(events, cap) {
  if (events.length <= cap) return { events, trimmed: false }
  const from = events.length - cap
  for (let index = from; index < events.length; index += 1) {
    const entry = events[index]
    // 客户端记录是 `{ type: 'event', event }` 或裸事件，两种都认。
    const type = entry?.event?.type ?? entry?.type
    if (type === 'turn/start') {
      return { events: events.slice(index), trimmed: true }
    }
  }
  return { events, trimmed: false }
}

/**
 * 安装历史页收窄。
 * @param {object} options - 安装参数。
 * @param {object} options.sessionController - `ctx.sessionController`。
 * @param {number | undefined} options.pageEvents - 一页事件数上限。
 * @param {boolean | undefined} options.rewrite - 是否改写翻页请求/回包。
 * @param {(line: string) => void} options.diag - 输出。
 * @returns {() => void} 还原函数。
 */
export function installHistoryCap({ sessionController, pageEvents, rewrite, diag }) {
  const history = sessionController?.historyController
  if (history === undefined) {
    diag('HISTORY-SKIP historyController-not-found')
    return () => {}
  }
  const proto = prototypeWith(history, 'events')
  if (proto === undefined) {
    diag('HISTORY-SKIP events-not-found')
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

  const original = proto.events
  const cap = typeof pageEvents === 'number' && Number.isSafeInteger(pageEvents) && pageEvents > 0
    ? pageEvents
    : DEFAULT_PAGE_EVENTS
  const rewriting = rewrite === true

  /** 统计：翻页次数、其中收紧成功的次数、省下的记录数。 */
  const stats = { pages: 0, trimmed: 0, recordsBefore: 0, recordsAfter: 0 }

  /**
   * 只把 `minTurns` 收到 1，让宿主尽早给出轮边界。
   *
   * 这一步是前提：`minTurns=2` 时宿主会为了凑两整轮继续往前吃。
   * 但它**不是**页大的主因（单轮大时不生效），主因由 `trimToTurnStart` 处理。
   *
   * `maxMessages` 保持客户端原值：压低它会撞消息兜底，页首落进轮中间。
   * @param {object} request - 客户端原始请求。
   * @returns {object} 改写后的请求，或原对象。
   */
  function narrow(request) {
    if (request === null || typeof request !== 'object') return request
    if (request.beforeSeq === undefined) return request
    const window = request.turnWindow
    if (window === undefined || window.minTurns === 1) return request
    return { ...request, turnWindow: { ...window, minTurns: 1 } }
  }

  /**
   * 记录一次翻页的耗时与体积。
   *
   * 分开量「宿主算页」与「序列化体积」：实测 host 恒为 0~1 ms，
   * 说明 500 ms 的等待几乎全在传输与客户端渲染，而不是 `paginate`。
   * @param {object} request - 原始请求。
   * @param {object} page - 最终返回的页。
   * @param {number} hostMs - 宿主耗时。
   */
  function reportCost(request, page, hostMs) {
    if (page === null || typeof page !== 'object') return
    if (request?.beforeSeq === undefined) return
    const records = Array.isArray(page.records) ? page.records.length : 0
    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(page.records ?? []))
    } catch {
      // 序列化失败不影响调用方。
    }
    diag(
      `HISTORY-COST beforeSeq=${request.beforeSeq}`
      + ` records=${records} bytes=${(bytes / 1024).toFixed(0)}KB host=${hostMs}ms`,
    )
  }

  async function events(request, signal) {
    // 改写关闭时完全透传：请求不碰、回包不碰，只记耗时。
    if (!rewriting) {
      const t0 = Date.now()
      const page = await original.call(this, request, signal)
      reportCost(request, page, Date.now() - t0)
      return page
    }
    const narrowedRequest = narrow(request)
    const t0 = Date.now()
    const page = await original.call(this, narrowedRequest, signal)
    const hostMs = Date.now() - t0

    let result = page
    if (request?.beforeSeq !== undefined && Array.isArray(page?.records) && page.records.length > cap) {
      stats.pages += 1
      stats.recordsBefore += page.records.length
      try {
        const trimmed = trimToTurnStart(page.records, cap)
        if (trimmed.trimmed) {
          // 页尾不变（仍然是游标处），只把页首往后挪。
          // `hasMore` 保持宿主给的值：更早的历史仍然存在。
          result = { ...page, records: trimmed.events }
          stats.trimmed += 1
          stats.recordsAfter += trimmed.events.length
        } else {
          stats.recordsAfter += page.records.length
        }
      } catch {
        // 收紧出错就原样返回，绝不改变语义。
        result = page
      }
    }

    reportCost(request, result, hostMs)
    return result
  }

  Object.defineProperty(proto, 'events', {
    value: events,
    writable: true,
    configurable: true,
    enumerable: false,
  })

  /** 还原。 */
  function restore() {
    // 迟到的旧 restore 不得摘掉新补丁：只有当前实现仍是自己装的那个时才还原。
    if (proto.events !== events) return
    Object.defineProperty(proto, 'events', {
      value: original,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    delete proto[PATCHED]
  }

  proto[PATCHED] = restore
  diag(
    `HISTORY-ARMED historyController.events cap=${cap} rewrite=${rewriting ? 'on' : 'off'}`
    + (rewriting ? ' (页首对齐轮边界)' : ' (纯计时透传)'),
  )

  const timer = setInterval(() => {
    if (stats.pages === 0) return
    const avgBefore = stats.pages === 0 ? 0 : stats.recordsBefore / stats.pages
    const avgAfter = stats.pages === 0 ? 0 : stats.recordsAfter / stats.pages
    diag(
      `HISTORY-PAGE pages=${stats.pages} trimmed=${stats.trimmed}`
      + ` avgBefore=${avgBefore.toFixed(0)} avgAfter=${avgAfter.toFixed(0)}`,
    )
    stats.pages = 0
    stats.trimmed = 0
    stats.recordsBefore = 0
    stats.recordsAfter = 0
  }, 60_000)
  if (typeof timer.unref === 'function') timer.unref()

  return () => {
    clearInterval(timer)
    restore()
  }
}
