/**
 * 首屏预缓存：把「未归档普通会话」的尾部窗口先在内存里备好。
 *
 * 动机（实测数据）：
 *   冷开时 `SessionController.follow` 要先 stat + 尾部读才能出首屏，
 *   线上实测 `stat=12~184ms` + `read=100~1004ms`。
 *   `read` 那一部分完全可以在空闲时预先算好，因为它只依赖文件内容。
 *
 * 范围（实测统计）：
 *   全部 835 个会话里 741 个是 subagent，剩下 94 个普通会话中 65 个已归档，
 *   真正需要缓存的只有 29 个未归档普通会话（合计 354 MB）。
 *
 * 单条代价（实测）：
 *   读 64 KB 尾部窗口 → 平均实际读 43 KB、解码 2 ms、中位拿到 4 条消息，
 *   99% 的会话都能凑出首屏。每条快照中位 5.4 KB、p90 34 KB、最大 520 KB。
 *   29 个合计不到 1 MB。
 *
 * 安全边界：
 *   - 缓存键用 `stat` 的 revision，文件一变就失效，不会给旧内容；
 *   - 只缓存「尾部窗口」，不含 projections，与原尾部读的产物同构；
 *   - 内存上限可配，超出按最近最少使用淘汰；
 *   - 生成过程逐个 await，绝不连续占住主线程。
 */

import { statSync } from 'node:fs'

import { readTailEventsFromFile } from './tail-read.js'

/** 缓存条目的默认内存上限（字节）。29 个会话实测远小于这个值。 */
const DEFAULT_BUDGET_BYTES = 4 * 1024 * 1024

/** 每个会话默认保留多少条消息的快照。 */
const DEFAULT_MESSAGES = 2

/** 启动后延迟多久开始预热，避开启动高峰。 */
const DEFAULT_DELAY_MS = 30000

/** 单个会话最多读多少字节的尾部窗口。 */
const TAIL_BYTES = 64 * 1024

/** 单条快照的大小上限。超过就不缓存，避免一条挤掉全部预算。 */
const ENTRY_MAX_BYTES = 256 * 1024

/** 预热期间每处理完一个会话就让出一次，避免连续占住主线程。 */
const YIELD_EVERY = 1

/**
 * 用「路径 + 大小 + mtime」做缓存键。
 *
 * 与 `sessionPersistence.stat` 的 revision 同源（都是文件身份），
 * 但这里只需要判断「文件变没变」，本地 stat 就够了，不必走服务层。
 * @param {string} path - 日志文件路径。
 * @returns {string | undefined} 缓存键；文件不可读时返回 undefined。
 */
function revisionOf(path) {
  try {
    const info = statSync(path)
    return `${info.size}:${info.mtimeMs}:${info.ino}`
  } catch {
    return undefined
  }
}

/**
 * 让出一次主线程。
 * @returns {Promise<void>} 下一个宏任务。
 */
function yieldOnce() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * 安装首屏预缓存。
 * @param {object} options - 安装参数。
 * @param {object} options.persistence - `ctx.sessionPersistence`。
 * @param {object | undefined} options.workspaceRegistry - `ctx.workspaceRegistry`，用于排除归档会话。
 * @param {() => number} options.maxMessages - 返回每条快照保留的消息条数。
 * @param {(line: string) => void} options.diag - 输出。
 * @param {number | undefined} options.budgetBytes - 内存上限。
 * @param {number | undefined} options.delayMs - 启动后延迟多久预热。
 * @returns {{ lookup: Function, stop: Function, stats: Function }} 缓存接口。
 */
export function installPrefetch({
  persistence,
  workspaceRegistry,
  maxMessages,
  diag,
  budgetBytes,
  delayMs,
}) {
  /** path → { key, snapshot, bytes, at } */
  const cache = new Map()
  let usedBytes = 0
  let stopped = false
  let timer
  let hits = 0
  let misses = 0
  let built = 0
  let oversized = 0
  let buildMs = 0

  const budget = typeof budgetBytes === 'number' && budgetBytes > 0
    ? budgetBytes
    : DEFAULT_BUDGET_BYTES
  const delay = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : DEFAULT_DELAY_MS

  /**
   * 判断一个会话是否应该被缓存：正常会话且未归档。
   *
   * **只排除 `origin: 'subagent'`**，不排除 `parentSession`：
   * 带 `parentSession` 且 `isSeeded: true` 的是 **fork 出来的会话**
   * （用户从某会话分叉继续），它会出现在侧栏、能被点开，是正常会话。
   * 之前把 `parentSession !== undefined` 也当排除条件，导致 fork 会话
   * 全部漏出预热范围——实测一个 20 MB 的 fork 会话就是这样 MISS 的。
   * @param {object} record - `persistence.list()` 的条目。
   * @returns {boolean} 是否缓存。
   */
  function eligible(record) {
    const header = record?.header
    if (header === undefined || header === null) return false
    if (header.origin === 'subagent') return false
    const location = record.location
    if (typeof location?.path !== 'string') return false
    if (!location.path.endsWith('.jsonl.zstd')) return false
    // 归档会话不预热：用户不常打开它们，留着内存给常用的。
    try {
      const archived = workspaceRegistry?.archivedSessionIds
      if (archived !== undefined && archived !== null) {
        const id = header.id
        for (const entry of archived) {
          if (entry === id) return false
        }
      }
    } catch {
      // 拿不到归档状态时按「未归档」处理，多缓存几个不影响正确性。
    }
    return true
  }

  /**
   * 预算内放入一条，必要时淘汰最久未使用的。
   * @param {string} path - 缓存键。
   * @param {object} entry - 缓存条目。
   */
  function put(path, entry) {
    const existing = cache.get(path)
    if (existing !== undefined) usedBytes -= existing.bytes
    cache.set(path, entry)
    usedBytes += entry.bytes
    while (usedBytes > budget && cache.size > 1) {
      // Map 保持插入顺序，第一条就是最久未使用（lookup 会重新 set）。
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined || oldestKey === path) break
      const oldest = cache.get(oldestKey)
      if (oldest !== undefined) usedBytes -= oldest.bytes
      cache.delete(oldestKey)
    }
  }

  /**
   * 为一个会话构建首屏快照。
   *
   * 单条体积有上限：实测个别会话的尾部窗口会因为超长的 tool/call 参数
   * 飙到 8.5 MB（一条 tool/call 的参数就有 25000 字符），
   * 那一条就吃掉整个预算、把其余会话全淘汰掉。所以超过上限的会话直接不缓存，
   * 让它走原来的尾部读——只损失那一个会话的加速，不影响其余 28 个。
   * @param {object} record - `persistence.list()` 的条目。
   * @returns {Promise<void>} 构建完成。
   */
  async function build(record) {
    const path = record.location.path
    const revision = revisionOf(path)
    if (revision === undefined) return
    const existing = cache.get(path)
    if (existing !== undefined && existing.key === revision) return

    const start = performance.now()
    let tail
    try {
      tail = await readTailEventsFromFile({
        path,
        maxMessages: maxMessages(),
      })
    } catch {
      return
    }
    const elapsedMs = performance.now() - start
    if (tail === undefined) return

    const snapshot = {
      type: 'snapshot',
      header: record.header,
      cursor: tail.cursor,
      records: tail.events.map(event => ({ type: 'event', event })),
      hasMore: tail.hasMore,
      assistantStream: { revision: 0 },
      // 与冷开快照一致：不给 projections，留给完整读取推送。
    }

    const bytes = Buffer.byteLength(JSON.stringify(snapshot))
    // 单条超过上限就不缓存：它会把预算整块吃掉、挤掉其余会话。
    if (bytes > ENTRY_MAX_BYTES) {
      oversized += 1
      diag(`PREFETCH skip-oversized ${record.header.id} ${(bytes / 1024).toFixed(0)}KB`)
      return
    }
    put(path, { key: revision, snapshot, bytes, at: Date.now() })
    built += 1
    buildMs += elapsedMs
  }

  /**
   * 预热：列出会话，挑出合格的，逐个构建。
   * @returns {Promise<void>} 全部完成。
   */
  async function warm() {
    if (stopped) return
    let records
    try {
      records = await persistence.list()
    } catch {
      return
    }
    if (stopped) return
    const targets = (Array.isArray(records) ? records : []).filter(eligible)
    diag(`PREFETCH begin targets=${targets.length}`)
    let processed = 0
    for (const record of targets) {
      if (stopped) return
      try {
        await build(record)
      } catch {
        // 单个失败不影响其余会话。
      }
      processed += 1
      if (processed % YIELD_EVERY === 0) await yieldOnce()
    }
    if (stopped) return
    const avg = built === 0 ? 0 : buildMs / built
    diag(
      `PREFETCH done built=${built}/${targets.length} oversized=${oversized}`
      + ` used=${(usedBytes / 1024).toFixed(0)}KB entries=${cache.size}`
      + ` avgBuild=${avg.toFixed(2)}ms`,
    )
  }

  /**
   * 查缓存。
   * @param {string} path - 日志文件路径。
   * @returns {object | undefined} 命中且 revision 一致时返回快照。
   */
  function lookup(path) {
    const entry = cache.get(path)
    if (entry === undefined) {
      misses += 1
      return undefined
    }
    const revision = revisionOf(path)
    if (revision !== entry.key) {
      // 文件变了：立刻作废，绝不返回旧内容。
      cache.delete(path)
      usedBytes -= entry.bytes
      misses += 1
      return undefined
    }
    // 命中后重新插入以维持 LRU 顺序。
    cache.delete(path)
    cache.set(path, entry)
    hits += 1
    return entry.snapshot
  }

  // 启动预热：延迟执行，避开启动高峰。
  timer = setTimeout(() => {
    timer = undefined
    void warm()
  }, delay)
  if (typeof timer.unref === 'function') timer.unref()

  // 成功安装必须留证：`PREFETCH begin/done` 只在真正开始预热后才有，
  // 若 `persistence.list` 在某版宿主里改名，会一条日志都没有。
  diag(
    `PREFETCH-ARMED messages=${typeof maxMessages === 'function' ? 'fn' : 'const'}`
    + ` budget=${(budget / 1048576).toFixed(0)}MB delay=${delay}ms`
    + ` list=${typeof persistence?.list === 'function' ? 'ok' : 'MISSING'}`
    + ` archived=${workspaceRegistry === undefined ? 'off' : 'on'}`,
  )

  return {
    lookup,
    /** 停掉未开始的预热并清空缓存。 */
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      cache.clear()
      usedBytes = 0
    },
    /** 读取统计，供诊断输出。 */
    stats() {
      return { hits, misses, built, entries: cache.size, usedBytes }
    },
  }
}

/** 供外部读取的默认值，便于文档与配置保持一致。 */
export const PREFETCH_DEFAULTS = {
  messages: DEFAULT_MESSAGES,
  budgetBytes: DEFAULT_BUDGET_BYTES,
  delayMs: DEFAULT_DELAY_MS,
  tailBytes: TAIL_BYTES,
}
