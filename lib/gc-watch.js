/**
 * 常驻卡顿归因：把「页面卡住」直接归因到 **GC** 或 **同步代码块**。
 *
 * 已有的 `LAG` 埋点只在冷开后 15 秒内采样，而实测显示大卡顿恰好落在这个
 * 窗口边缘甚至之外（`+17546:10136`），而且 1.57 MB 的小会话也能卡 10 秒——
 * 冷读只用了 143 ms，所以卡顿既不在磁盘也不在解压。
 *
 * 本模块改成**常驻**观测，只在真的卡了的时候输出一行，包含：
 *   - 卡了多久；
 *   - 同期是否有 GC，是哪一种、多长；
 *   - 当前堆大小。
 * 这样用户正常用，卡一下就会留一条证据，不需要刻意复现。
 *
 * 只读观测：不改任何行为，不改包不改配置。
 */

import { PerformanceObserver } from 'node:perf_hooks'

/** 安装标记，避免热重载重复安装。 */
const PATCHED = Symbol.for('dsh.sessionFirstpaint.gcwatch')

/** 采样间隔（毫秒）：略大于一帧，能区分正常调度与主线程被占。 */
const SAMPLE_MS = 20

/** 主线程阻塞超过这个时长才报告。 */
const DEFAULT_STALL_MS = 120

/** 单次 GC 超过这个时长也单独报告。 */
const DEFAULT_GC_MS = 150

/** 两次报告之间的最小间隔，避免一次长卡刷出几十行。 */
const REPORT_COOLDOWN_MS = 1000

/** V8 GC kind 的可读名称。 */
function gcName(kind) {
  switch (kind) {
    case 1: return 'scavenge'
    case 2: return 'mark-compact'
    case 3: return 'mark-sweep'
    case 4: return 'incremental'
    case 5: return 'weakcb'
    default: return `kind${kind}`
  }
}

/**
 * 安装常驻观测。
 * @param {object} options - 安装参数。
 * @param {(line: string) => void} options.diag - 输出。
 * @param {number | undefined} options.stallMs - 阻塞报告阈值。
 * @param {number | undefined} options.gcMs - GC 报告阈值。
 * @param {((stallMs: number) => void) | undefined} options.onStall - 检测到卡顿时的回调，
 *   用来触发 CPU 热点采样。
 * @returns {() => void} 停止函数。
 */
export function installGcWatch({ diag, stallMs, gcMs, onStall }) {
  const globalObject = globalThis
  const previous = globalObject[PATCHED]
  if (typeof previous === 'function') {
    try {
      previous()
    } catch {
      // 旧观测停止失败不阻止新观测安装。
    }
  }

  const stallThreshold = typeof stallMs === 'number' && stallMs > 0 ? stallMs : DEFAULT_STALL_MS
  const gcThreshold = typeof gcMs === 'number' && gcMs > 0 ? gcMs : DEFAULT_GC_MS
  const stallHook = typeof onStall === 'function' ? onStall : undefined

  const startedAt = Date.now()
  let stopped = false
  let lastReportAt = 0
  let observer

  /**
   * 最近发生的慢 GC，用于把紧随其后的阻塞归因为 GC。
   * 只保留最近 4 条，够覆盖「GC 结束 → 定时器才被调度」这类延迟。
   */
  const recentGc = []

  /** 同一时刻只报告一次。 */
  function report(line) {
    const now = Date.now()
    if (now - lastReportAt < REPORT_COOLDOWN_MS) return
    lastReportAt = now
    diag(line)
  }

  function heapMb() {
    return (process.memoryUsage().heapUsed / 1048576).toFixed(0)
  }

  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const duration = entry.duration
        const kind = gcName(entry.detail?.kind ?? 0)
        const at = Date.now() - startedAt
        // 无论大小都记入时间轴：增量 GC 由许多小步骤组成，
        // 单步都很短，但累计起来同样会占住主线程。
        recentGc.push({ at, duration, kind })
        if (recentGc.length > 400) recentGc.shift()
        if (duration >= gcThreshold) {
          report(`GC ${duration.toFixed(0)}ms ${kind} heap=${heapMb()}MB at=+${at}ms`)
        }
      }
    })
    observer.observe({ entryTypes: ['gc'] })
  } catch (error) {
    diag(`GCWATCH observer-unavailable ${String(error)}`)
  }

  let last = Date.now()
  const timer = setInterval(() => {
    if (stopped) return
    const now = Date.now()
    const elapsed = now - last
    last = now
    const stall = elapsed - SAMPLE_MS
    if (stall < stallThreshold) return
    const at = now - startedAt
    // 让 CPU profiler 先把这段阻塞的样本单独归纳出来，作为主责证据。
    if (stallHook !== undefined) {
      try {
        stallHook(stall)
      } catch {
        // 归因失败不影响卡顿报告。
      }
    }
    // 关键：GC 的 PerformanceObserver 条目是在 GC 结束后才投递的，
    // 而定时器回调可能先于它执行。若此刻就判定，长 GC 会被误判成 not-gc。
    // 所以延后一个宏任务再归因，让本轮已排队的 GC 条目先排干。
    setTimeout(() => {
      if (stopped) return
      // 阻塞区间大致是 [at - stall, at]；前后各留 500 ms 余量吸收时钟误差。
      const from = at - stall - 500
      const to = at + 500
      const overlapping = recentGc.filter(item => item.at >= from && item.at <= to)
      const gcTotal = overlapping.reduce((sum, item) => sum + item.duration, 0)
      // GC 至少覆盖了阻塞时长的 60%，才判定为「卡顿由 GC 造成」。
      const attributed = stall > 0 && gcTotal / stall >= 0.6
      // 只列有实质长度的 GC，避免一串 0ms 的 scavenge 淹没日志。
      const notable = overlapping
        .filter(item => item.duration >= 1)
        .sort((left, right) => right.duration - left.duration)
        .slice(0, 4)
      const detail = notable.length === 0
        ? ''
        : `(${notable.map(item => `${item.duration.toFixed(0)}ms/${item.kind}`).join('+')})`
      const suffix = attributed
        ? ` cause=gc ${gcTotal.toFixed(0)}ms ${overlapping.length}次${detail}`
        : ` cause=not-gc gcInWindow=${gcTotal.toFixed(0)}ms/${overlapping.length}次${detail}`
      report(`STALL ${stall}ms heap=${heapMb()}MB at=+${at}ms${suffix}`)
    }, 0)
  }, SAMPLE_MS)
  if (typeof timer.unref === 'function') timer.unref()

  /** 停止观测。 */
  function stop() {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    try {
      observer?.disconnect()
    } catch {
      // 断开失败无所谓。
    }
    delete globalObject[PATCHED]
  }

  globalObject[PATCHED] = stop
  return stop
}
