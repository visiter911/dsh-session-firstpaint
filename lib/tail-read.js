/**
 * 尾部优先读取 zstd 会话日志：不依赖 DSH 内部包，只用 node:fs / node:zlib。
 *
 * 目的：冷会话首屏只需要最近若干条消息，不需要把 54 MB / 6 万个事件全解压一遍。
 * zstd 帧是独立可解码的（带 checksum），所以先做纯结构扫描定位帧边界，
 * 再从文件尾部往前逐帧解压，凑够消息数就停。
 *
 * 实测（54 MB / 34949 帧）：结构扫描约 94 ms，全量解压约 3.6 s，
 * 因此尾部读能把首屏从秒级压到百毫秒级。
 */

import { open } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧起始 magic（little-endian 读出的 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xFD2FB528

/** 计入「消息数」的事件类型；与 host 端 paginate 的口径一致。 */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * 纯结构扫描，不解压任何块，返回每个完整帧的字节范围。
 * 尾部不完整帧（崩溃残留）通过 `tornStart` 报出，调用方可以选择忽略。
 * @param {Buffer} buffer - 整个日志文件字节。
 * @returns {{ frames: Array<{start: number, end: number}>, tornStart?: number }}
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`会话日志帧头损坏：偏移 ${offset} 处 magic 不匹配`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`会话日志帧头损坏：偏移 ${offset - 1} 处保留位非零`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`会话日志块头损坏：偏移 ${offset - 3} 处保留类型`)
      }
      // RLE 块只占 1 字节负载，其余按 blockSize 走。
      offset += blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < 0) return { frames, tornStart: start }
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 解压一帧并切成非空行；单行 JSON 解析失败时跳过而不是整次读取失败。 */
function decodeFrame(buffer, frame) {
  const plaintext = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
  const events = []
  for (const line of plaintext.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 半行或损坏行：首屏可以容忍，完整读取路径会另行校验。
    }
  }
  return events
}

/**
 * 去掉首屏渲染用不到的冗余字段，只保留正文与折叠行所需的结构。
 *
 * 实测某会话 50 条消息的尾部窗口共 1468 KB，其中：
 * - `assistant/message.data.stream` 525 KB（36%）：与 message.content 重复的
 *   紧凑流记录，客户端只有 trajectory 视图取 firstTokenTime；置空数组即可，
 *   `assistantStreamFirstTokenTime([])` 返回 undefined，调用方有 `??` 兜底。
 * - `request/header.data.header.tools` 405 KB（28%）：140 个工具的完整 schema，
 *   只在「请求详情」面板展示；消费方写的是
 *   `Array.isArray(rawTools) ? rawTools : []`，缺省即空数组，不会抛错。
 *
 * 只动这两个字段，事件 envelope、seq、以及 tool/call 参数与 tool/result 正文
 * 全部原样保留——那些是「展开后才看」的内容，丢了就无法复原。
 *
 * @param {object} event - 解析出来的单个事件（本函数就地修改，调用方独占）。
 * @returns {object} 同一个事件对象。
 */
function trimForFirstPaint(event) {
  if (event.type === 'assistant/message') {
    const data = event.data
    if (data !== null && typeof data === 'object' && data.stream !== undefined) {
      data.stream = []
    }
    return event
  }
  if (event.type === 'request/header') {
    const header = event.data?.header
    if (header !== null && typeof header === 'object' && header.tools !== undefined) {
      delete header.tools
    }
    return event
  }
  return event
}

/**
 * 从日志尾部往前读，凑够 `maxMessages` 条消息后返回一个连续窗口。
 *
 * 窗口起点会尽量对齐到 `turn/start`，避免首屏从一轮对话中间开始渲染。
 * 返回的事件保持原始顺序与原始 seq，客户端靠 seq 连续性做校验。
 *
 * @param {object} options
 * @param {string} options.path - 当前格式代的日志绝对路径。
 * @param {number} [options.maxMessages] - 目标消息条数，默认 200。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<{events: Array<object>, cursor: number, hasMore: boolean, frames: number, elapsedMs: number} | undefined>}
 *   事件列表、末条 seq、是否还有更早历史；无法解析时返回 undefined 让调用方回退。
 */
export function readTailEvents({ path, buffer, maxMessages = 50, signal }) {
  return collectWindow(buffer, { maxMessages, signal, bufferStartsAtFileStart: true })
}

/** zstd 帧起始 magic 的字节序列（`readUInt32LE` 读出 0xFD2FB528）。 */
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 找出缓冲区里所有可能是帧起始的偏移。
 *
 * magic 也可能偶然出现在压缩数据内部，所以这里只给出候选，
 * 真正验证由 {@link firstValidFrameStart} 的结构扫描完成。
 * @param {Buffer} buffer - 待搜索的字节区间。
 * @returns {number[]} 候选偏移，升序。
 */
function frameStartCandidates(buffer) {
  const starts = []
  let index = buffer.indexOf(ZSTD_FRAME_MAGIC, 0)
  while (index !== -1) {
    starts.push(index)
    index = buffer.indexOf(ZSTD_FRAME_MAGIC, index + 1)
  }
  return starts
}

/**
 * 找到缓冲区里第一个**真正**的帧起始偏移。
 *
 * 判定标准：从该偏移结构扫描不报错，且扫描出的完整帧（或未完成的尾帧）
 * 恰好覆盖到缓冲区末尾。这样既排除了压缩数据里偶然出现的 magic，
 * 也自动跳过了因为窗口切分而残缺的首帧。
 * @param {Buffer} buffer - 待判定的字节区间。
 * @returns {number | undefined} 有效起始偏移，没有则 undefined。
 */
function firstValidFrameStart(buffer) {
  for (const start of frameStartCandidates(buffer)) {
    try {
      const { frames, tornStart } = scanZstdFrames(buffer.subarray(start))
      if (frames.length === 0) continue
      const end = start + (tornStart === undefined ? frames.at(-1).end : tornStart)
      if (end === buffer.length) return start
    } catch {
      // 这个候选不是帧起始，继续试下一个。
    }
  }
  return undefined
}

/**
 * 把一段尾部字节解成首屏窗口。
 *
 * `bufferStartsAtFileStart` 区分两种输入：整份文件（第一帧是 header，要跳过）
 * 与尾部切片（第一帧就是普通事件帧，不能跳）。这个区别一旦搞错，
 * 窗口就会少一帧或多一帧，seq 连续性校验会失败并整体退回原实现。
 *
 * @param {Buffer} buffer - 整份文件或尾部切片。
 * @param {object} options - 目标条数、取消信号、是否从文件开头开始。
 * @returns {object | undefined} 窗口结果，或 undefined 表示需要更多数据。
 */
function collectWindow(buffer, { maxMessages, signal, bufferStartsAtFileStart }) {
  const startedAt = Date.now()
  signal?.throwIfAborted()

  let region = buffer
  let skipLeadingFrames = 0
  if (!bufferStartsAtFileStart) {
    const frameStart = firstValidFrameStart(buffer)
    if (frameStart === undefined) return undefined
    region = buffer.subarray(frameStart)
  } else {
    // 整份文件：第一帧是 header 帧，不含事件。
    skipLeadingFrames = 1
  }

  const { frames } = scanZstdFrames(region)
  if (frames.length <= skipLeadingFrames) return undefined

  /** 从尾部往前的帧，按时间正序收集。 */
  let collected = []
  let messageCount = 0
  let frameCount = 0
  for (let index = frames.length - 1; index >= skipLeadingFrames; index -= 1) {
    signal?.throwIfAborted()
    const events = decodeFrame(region, frames[index])
    if (events.length === 0) continue
    collected = [...events, ...collected]
    frameCount += 1
    for (const event of events) {
      if (MESSAGE_TYPES.has(event.type)) messageCount += 1
    }
    if (messageCount >= maxMessages) break
  }

  if (collected.length === 0) return undefined

  // 关键：凑够消息数后还要**按消息边界截断**。
  // 之前直接返回全部 collected，导致「文件小于初始窗口」的会话
  // （实测 3.1 MB 的文件会一次读完）把整份日志都塞进快照：
  // n=1/2/3 都返回 4292 个事件、7.4 MB payload，被单条上限判为 oversized 跳过。
  // 现在从尾部往前数，凑满 maxMessages 条就把更早的部分丢掉。
  {
    let seen = 0
    let cut = collected.length
    for (let index = collected.length - 1; index >= 0; index -= 1) {
      if (MESSAGE_TYPES.has(collected[index].type)) {
        seen += 1
        if (seen >= maxMessages) {
          cut = index
          break
        }
      }
    }
    // 从 cut 开始保留：这样窗口正好以第 maxMessages 条消息开头。
    if (seen >= maxMessages && cut > 0) collected = collected.slice(cut)
  }

  // 不做 turn/start 对齐：那会为了补齐一轮而多解压若干帧，反而拖慢首屏。
  // 从尾部直接截断，视觉上就是从最近几条消息开始，往上滚才补更早的历史。
  const events = collected
  if (events.length === 0) return undefined

  // 首条事件必须有合法 seq，且窗口本身要连续，否则交给调用方回退。
  for (let index = 0; index < events.length; index += 1) {
    const seq = events[index]?.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined
    if (index > 0 && seq !== events[index - 1].seq + 1) return undefined
  }

  const first = events[0].seq
  const cursor = events.at(-1).seq
  // 首屏裁剪只在确认窗口连续之后进行，避免影响调用方对 seq 的判断。
  let rawBytes = 0
  for (const event of events) rawBytes += JSON.stringify(event)?.length ?? 0
  for (const event of events) trimForFirstPaint(event)
  let trimmedBytes = 0
  for (const event of events) trimmedBytes += JSON.stringify(event)?.length ?? 0
  return {
    events,
    cursor,
    hasMore: first > 0,
    frames: frames.length,
    decodedFrames: frameCount,
    messages: messageCount,
    rawKB: Math.round(rawBytes / 1024),
    trimmedKB: Math.round(trimmedBytes / 1024),
    elapsedMs: Date.now() - startedAt,
  }
}

/** 只解出 header 行（第一帧），用于确认格式代与身份。 */
export function readHeaderEvent(buffer) {
  const { frames } = scanZstdFrames(buffer)
  if (frames.length === 0) return undefined
  const events = decodeFrame(buffer, frames[0])
  return events[0]
}

/** 尾部窗口的分段读取起始大小：足够覆盖 50 条消息的常见情形。 */
const INITIAL_TAIL_BYTES = 4 * 1024 * 1024

/** 每次不足时往前扩张的步长。 */
const TAIL_GROWTH_FACTOR = 4

/**
 * 只读文件尾部就凑出首屏窗口，绝不把整份日志载入内存。
 *
 * 为什么必须分段：调用方（原实现）紧随其后还要把整份日志读一遍，
 * 如果这里也 `readFile` 整份，一次冷开就要读两倍字节。
 * 54 MB 的日志实测因此从 110 MB 磁盘读降到 ~55 MB。
 *
 * 策略：先读最后 4 MB，切出完整帧后从尾部往前解压；
 * 凑不够目标消息数就往前扩 4 倍再试，直到覆盖整个文件或用尽预算。
 *
 * @param {object} options
 * @param {string} options.path - 日志绝对路径。
 * @param {number} [options.maxMessages] - 目标消息条数。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<object | undefined>} 与 {@link readTailEvents} 同形，失败返回 undefined。
 */
export async function readTailEventsFromFile({ path, maxMessages = 50, signal }) {
  const startedAt = Date.now()
  signal?.throwIfAborted()

  let handle
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    if (size === 0) return undefined

    let windowBytes = Math.min(INITIAL_TAIL_BYTES, size)
    let bytesReadTotal = 0
    for (;;) {
      signal?.throwIfAborted()
      const startOffset = size - windowBytes
      const buffer = Buffer.allocUnsafe(windowBytes)
      const { bytesRead } = await handle.read(buffer, 0, windowBytes, startOffset)
      bytesReadTotal += bytesRead
      const slice = bytesRead === windowBytes ? buffer : buffer.subarray(0, bytesRead)

      // 只有从文件开头读起时才把第一帧当 header 跳过；
      // 尾部切片的第一帧就是普通事件帧。
      const fromFileStart = startOffset === 0
      const result = collectWindow(slice, {
        maxMessages,
        signal,
        bufferStartsAtFileStart: fromFileStart,
      })
      if (result !== undefined) {
        return {
          ...result,
          // 窗口是否触到文件开头决定了还能不能继续往前翻。
          hasMore: result.events[0].seq > 0,
          bytesRead: bytesReadTotal,
          windowBytes: slice.length,
          fromFileStart,
          readMs: Date.now() - startedAt - result.elapsedMs,
        }
      }
      if (fromFileStart) return undefined
      const next = Math.min(windowBytes * TAIL_GROWTH_FACTOR, size)
      if (next === windowBytes) return undefined
      windowBytes = next
    }
  } catch (error) {
    if (signal?.aborted === true) return undefined
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
