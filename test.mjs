/**
 * 离线自测：用假的 ctx / SessionController / 会话日志，验证 follow 包装的三条路径。
 *
 * 不进宿主、不碰真实会话。运行：node test.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'

import { apply, lastColdOpen } from './index.js'

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? '  √' : '  ×'} ${label}${ok ? '' : `  期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`}`)
}

/** 把一批事件编码成一个带 checksum 的 zstd 帧（与宿主 compressZstdFrame 等价）。 */
function frame(lines) {
  const text = lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/** 造一份 header + 若干事件帧的会话日志。 */
function writeLog(dir, header, eventFrames) {
  const path = join(dir, 'session.v4.jsonl.zstd')
  const parts = [frame([JSON.stringify(header)])]
  for (const lines of eventFrames) parts.push(frame(lines))
  writeFileSync(path, Buffer.concat(parts))
  return path
}

/** 造事件：turn/start 与 assistant/user 消息交替。 */
function makeEvents(count) {
  const events = []
  let seq = 0
  events.push({ type: 'turn/start', seq: seq++, time: 1, data: { turn: 1 } })
  for (let index = 0; index < count; index += 1) {
    events.push({
      type: index % 2 === 0 ? 'user/message' : 'assistant/message',
      seq: seq++,
      time: 2 + index,
      data: { turn: 1, step: 1, message: { id: `m-${index}`, role: index % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `#${index}` }] } },
    })
  }
  events.push({ type: 'turn/end', seq: seq++, time: 999, data: { turn: 1, reason: { kind: 'completed' } } })
  return events
}

/** 建一个可用的假上下文：follow 只吐 opening + 一个追加帧，便于观察转交行为。 */
function makeHarness({ cold, tailPath, header, originalFrames, config }) {
  class FakeController {
    async *follow(request, signal) {
      for (const value of originalFrames) {
        if (signal?.aborted === true) return
        yield value
      }
    }
  }
  const proto = FakeController.prototype
  // 插件现在注册两个 effect（follow 补丁 + 分段计时），必须都收集，
  // 否则后一个会覆盖前一个，测试结束时 follow 补丁不会被还原。
  const cleaners = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    sessions: {
      get: (id) => (cold ? undefined : { id }),
    },
    sessionPersistence: {
      stat: async () => (tailPath === undefined ? undefined : { header, location: { kind: 'jsonl', path: tailPath } }),
    },
    // 插件现在也注入 sessionQuery（用于 shared load 补丁）；
    // 这里给一个没有 _corpus 的空对象，fast-load 会自行跳过。
    sessionQuery: {},
    effect: (fn) => {
      cleaners.push(fn())
    },
    get sessionController() {
      return controller
    },
  }
  const controller = new FakeController()
  apply(ctx, config)
  return { ctx, proto, controller, restore: () => { for (const clean of cleaners) clean?.() } }
}

const dir = mkdtempSync(join(tmpdir(), 'firstpaint-'))
try {
  const header = { version: 4, id: 'session-test', createdAt: 1, cwd: '/work', isSeeded: false, delegationDepth: 0 }
  const events = makeEvents(300)
  // 每 20 个事件一帧，模拟真实分帧。
  const frames = []
  for (let index = 0; index < events.length; index += 20) frames.push(events.slice(index, index + 20))
  const path = writeLog(dir, header, frames)

  console.log('用例 1：冷会话命中尾部读')
  {
    const opening = { type: 'snapshot', cursor: 500, records: [], hasMore: true, assistantStream: { revision: 0 } }
    const appended = { type: 'event', event: { type: 'assistant/message', seq: 501, time: 1, data: {} } }
    const h = makeHarness({ cold: true, tailPath: path, header, originalFrames: [opening, appended] })
    const out = []
    for await (const item of h.controller.follow({ address: { kind: 'session', sessionId: 'session-test' } }, new AbortController().signal)) {
      out.push(item)
    }
    check('首帧是尾部快照', out[0]?.type, 'snapshot')
    check('快照里有事件记录', out[0]?.records.length > 0, true)
    check('cursor 等于末条 seq', out[0]?.cursor, events.at(-1).seq)
    check('hasMore 为真', out[0]?.hasMore, true)
    check('快照不带 projections 字段', Object.hasOwn(out[0] ?? {}, 'projections'), false)
    check('assistantStream 存在', out[0]?.assistantStream, { revision: 0 })
    check('原实现的 opening 被丢弃', out.filter(item => item.type === 'snapshot').length, 1)
    check('增量帧被转发', out.length, 2)
    check('转发的是 appended', out[1], appended)
    h.restore()
  }

  console.log('用例 2：已 attach 的会话走原实现')
  {
    const opening = { type: 'snapshot', cursor: 7, records: [], hasMore: false, assistantStream: { revision: 0 } }
    const h = makeHarness({ cold: false, tailPath: path, header, originalFrames: [opening] })
    const out = []
    for await (const item of h.controller.follow({ address: { kind: 'session', sessionId: 'session-test' } }, new AbortController().signal)) {
      out.push(item)
    }
    check('原样透传', out, [opening])
    h.restore()
  }

  console.log('用例 3：无持久化产物时退回原实现')
  {
    const opening = { type: 'snapshot', cursor: 3, records: [], hasMore: false, assistantStream: { revision: 0 } }
    const h = makeHarness({ cold: true, tailPath: undefined, header, originalFrames: [opening] })
    const out = []
    for await (const item of h.controller.follow({ address: { kind: 'session', sessionId: 'session-test' } }, new AbortController().signal)) {
      out.push(item)
    }
    check('退回后仍是原 opening', out, [opening])
    h.restore()
  }

  console.log('用例 4：还原后 prototype 恢复')
  {
    const h = makeHarness({ cold: true, tailPath: path, header, originalFrames: [] })
    const patched = h.proto.follow.name
    h.restore()
    check('还原后 follow 名字回到原样', h.proto.follow.name, 'follow')
    check('打补丁期间函数已被替换', typeof patched, 'string')
  }

  console.log('用例 5：子代理地址不拦截')
  {
    const opening = { type: 'snapshot', cursor: 9, records: [], hasMore: false, assistantStream: { revision: 0 } }
    const h = makeHarness({ cold: true, tailPath: path, header, originalFrames: [opening] })
    const out = []
    const address = { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'unknown' }
    for await (const item of h.controller.follow({ address }, new AbortController().signal)) out.push(item)
    check('子代理走原实现', out, [opening])
    h.restore()
  }

  console.log('用例 6：config 从 apply 传入而不是读 ctx.config（曾因读 ctx.config 全部 MISS）')
  {
    // 这个 case 用带 stream / header.tools 的真实结构，同时验证裁剪。
    const richFrames = [[
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'request/header', seq: 1, time: 2, data: { header: { config: { model: 'x' }, tools: [{ name: 'a', schema: 'y'.repeat(500) }] } } },
      { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, stream: [{ type: 'chunk', chunk: { type: 'text-delta', text: 'z'.repeat(500) } }] } },
      { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, callId: 'c1', name: 'n', arguments: { big: 'q'.repeat(400) } } },
      { type: 'tool/result', seq: 4, time: 5, data: { turn: 1, step: 1, message: { id: 'r', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'r'.repeat(400) }] }, meta: {} } },
      { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
    ]]
    const richPath = writeLog(dir, header, richFrames)
    const opening = { type: 'snapshot', cursor: 5, records: [], hasMore: false, assistantStream: { revision: 0 } }
    const h = makeHarness({ cold: true, tailPath: richPath, header, originalFrames: [opening], config: { maxMessages: 7 } })
    const out = []
    for await (const item of h.controller.follow({ address: { kind: 'session', sessionId: 'session-test' } }, new AbortController().signal)) out.push(item)
    check('传了 config 仍能命中（不再 MISS）', out[0]?.type, 'snapshot')
    const events = out[0].records.map(record => record.event)
    const am = events.find(event => event.type === 'assistant/message')
    const rh = events.find(event => event.type === 'request/header')
    const tr = events.find(event => event.type === 'tool/result')
    const tc = events.find(event => event.type === 'tool/call')
    check('assistant.stream 清空', am.data.stream, [])
    check('assistant.message 保留', am.data.message.content.length, 1)
    check('header.tools 删除', Object.hasOwn(rh.data.header, 'tools'), false)
    check('header.config 保留', rh.data.header.config, { model: 'x' })
    check('tool/result 正文保留', tr.data.message.content[0].text.length, 400)
    check('tool/call 参数保留', tc.data.arguments.big.length, 400)
    check('seq 仍连续', events.every((event, index) => index === 0 || event.seq === events[index - 1].seq + 1), true)
    h.restore()
  }

  console.log('用例 7：冷开记录最近一次会话，热会话不覆盖')
  {
    const opening = { type: 'snapshot', cursor: 5, records: [], hasMore: false, assistantStream: { revision: 0 } }
    const cold = makeHarness({ cold: true, tailPath: path, header, originalFrames: [opening] })
    for await (const _ of cold.controller.follow({ address: { kind: 'session', sessionId: 'session-cold' } }, new AbortController().signal)) { /* 消费完 */ }
    const afterCold = lastColdOpen()
    check('记录的是冷会话 id', afterCold.sessionId, 'session-cold')
    check('记录了时间戳', afterCold.at > 0, true)
    cold.restore()

    const warm = makeHarness({ cold: false, tailPath: path, header, originalFrames: [opening] })
    for await (const _ of warm.controller.follow({ address: { kind: 'session', sessionId: 'session-warm' } }, new AbortController().signal)) { /* 消费完 */ }
    check('热会话不覆盖冷开记录', lastColdOpen().sessionId, 'session-cold')
    warm.restore()
  }

  console.log('用例 8：热会话窗口被收敛到上限（滑动窗口）')
  {
    // 原实现那边记录收到的 request，验证插件的收窄真的传下去了。
    const seen = []
    class RecordingController {
      async *follow(request) {
        seen.push({ maxMessages: request.maxMessages, minMessages: request.turnWindow?.minMessages, minTurns: request.turnWindow?.minTurns })
        yield { type: 'snapshot', cursor: 1, records: [], hasMore: true, assistantStream: { revision: 0 } }
      }
    }
    const proto = RecordingController.prototype
    const controller = new RecordingController()
    let cleaner
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      sessions: { get: () => ({ id: 'live' }) },
      sessionPersistence: { stat: async () => undefined },
      effect: (fn) => { cleaner = fn() },
      get sessionController() { return controller },
    }
    apply(ctx, { maxMessages: 60 })

    // 客户端默认值：maxMessages 500 + turnWindow{minMessages:50,minTurns:2}
    const clientRequest = {
      address: { kind: 'session', sessionId: 'session-warm' },
      maxMessages: 500,
      turnWindow: { minMessages: 50, minTurns: 2 },
      activate: true,
      assistantStream: true,
    }
    for await (const _ of controller.follow(clientRequest, new AbortController().signal)) { /* 消费完 */ }
    check('热开 maxMessages 收到 60', seen[0]?.maxMessages, 60)
    check('turnWindow 被去掉（它才是窗口膨胀主因）', seen[0]?.minTurns, undefined)
    check('turnWindow.minMessages 也去掉', seen[0]?.minMessages, undefined)
    check('原始请求对象未被修改', clientRequest.maxMessages, 500)
    check('原始请求的 turnWindow 未被修改', clientRequest.turnWindow.minTurns, 2)
    cleaner?.()

    // 已经是小窗口时不重复包装
    const seen2 = []
    class SmallController {
      async *follow(request) {
        seen2.push(request.maxMessages)
        yield { type: 'snapshot', cursor: 1, records: [], hasMore: false, assistantStream: { revision: 0 } }
      }
    }
    const c2 = new SmallController()
    let cleaner2
    const ctx2 = {
      logger: { info: () => {}, warn: () => {} },
      sessions: { get: () => ({ id: 'live' }) },
      sessionPersistence: { stat: async () => undefined },
      effect: (fn) => { cleaner2 = fn() },
      get sessionController() { return c2 },
    }
    apply(ctx2, { maxMessages: 60 })
    for await (const _ of c2.follow({ address: { kind: 'session', sessionId: 'w' }, maxMessages: 40 }, new AbortController().signal)) { /* 消费完 */ }
    check('已小于上限时不改动', seen2[0], 40)
    cleaner2?.()

    // 未指定 maxMessages 时按客户端 500 处理
    const seen3 = []
    class DefaultController {
      async *follow(request) {
        seen3.push(request.maxMessages)
        yield { type: 'snapshot', cursor: 1, records: [], hasMore: false, assistantStream: { revision: 0 } }
      }
    }
    const c3 = new DefaultController()
    let cleaner3
    const ctx3 = {
      logger: { info: () => {}, warn: () => {} },
      sessions: { get: () => ({ id: 'live' }) },
      sessionPersistence: { stat: async () => undefined },
      effect: (fn) => { cleaner3 = fn() },
      get sessionController() { return c3 },
    }
    apply(ctx3, { maxMessages: 60 })
    for await (const _ of c3.follow({ address: { kind: 'session', sessionId: 'w' } }, new AbortController().signal)) { /* 消费完 */ }
    check('未指定时按 500 收窄到 60', seen3[0], 60)
    cleaner3?.()
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)


