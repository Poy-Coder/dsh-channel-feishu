/**
 * Hermetic tests for the plain-text stream policy used by channels without
 * editable messages (WeChat): progress cadence, early first slice, boundary
 * splits, code fences, finish flushing and the message budget.
 *
 * Usage: node test/text-stream.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'feishu-textstream-'))

const { TEXT_STREAM_LIMITS, createTextStream, streamLimitsFromConfig, toWechatText } = await import('../providers/text-stream.js')

const progressLine = (tool, calls, seconds) =>
  `思考中…\n\n<font color="grey">正在执行 ${tool} · 已调用 ${calls} 个工具 · 已用时 ${seconds}s</font>`

// 1. Plain-text conversion: WeChat renders no HTML and no Markdown.
assert.equal(toWechatText('<font color="grey">已选：甲</font>'), '已选：甲')
assert.equal(toWechatText('## 标题\n**粗体** 和 `code`'), '标题\n粗体 和 `code`', '行内代码保留反引号')
assert.equal(toWechatText('看 [文档](https://x.dev/a) 吧'), '看 文档 (https://x.dev/a) 吧')
assert.equal(toWechatText('- 一\n- 二'), '· 一\n· 二')
assert.equal(toWechatText('```js\nconst a = 1\n```'), '```js\nconst a = 1\n```', '代码块围栏保留')
assert.equal(toWechatText('| a | b |\n|---|---|\n| 1 | 2 |'), '| a | b |\n|---|---|\n| 1 | 2 |', '表格保留')
assert.equal(toWechatText('```\n- 不是列表\n**不是粗体**\n```'), '```\n- 不是列表\n**不是粗体**\n```', '代码块内容原样')

// 2. A fresh turn opens the typing indicator exactly once.
let clock = 0
const stream = createTextStream({ now: () => clock })
assert.deepEqual(stream.begin(), [{ kind: 'typing', on: true }])
assert.deepEqual(stream.begin(), [])

// 3. Progress is silent for the first 45 s, then one bubble; the same status
//    ticker must not repeat, a changed tool does.
clock = 10_000
assert.deepEqual(stream.push(progressLine('pwsh', 2, 10)), [])
clock = 50_000
const firstProgress = stream.push(progressLine('pwsh', 2, 50))
assert.equal(firstProgress.length, 1)
assert.equal(firstProgress[0].tag, 'progress')
assert.match(firstProgress[0].text, /正在执行 pwsh/)
assert.match(firstProgress[0].text, /已用时 50s/)
assert.doesNotMatch(firstProgress[0].text, /<font/)
clock = 70_000
assert.deepEqual(stream.push(progressLine('pwsh', 2, 70)), [], '同样的状态不刷屏')
clock = 240_000
const secondProgress = stream.push(progressLine('feishu_send_file', 5, 240))
assert.equal(secondProgress.length, 1)
assert.match(secondProgress[0].text, /feishu_send_file/)
// The first bubble teaches `/why` even on a busy turn that never reaches the
// "nothing to report" branch; later bubbles stay terse.
assert.match(firstProgress[0].text, /\/why/, '第一条进度必须让人知道 /why')
assert.doesNotMatch(secondProgress[0].text, /\/why/, '后面的进度不再重复提示')

// 3b. A turn that keeps running with no new status still gets a cadence: one
//     bubble per gap, capped at progressMax. Before this, a long thinking turn
//     produced exactly one bubble at 30 s and then silence, so it looked dead.
clock = 0
const cadence = createTextStream({ now: () => clock })
cadence.begin()
const sameStatus = (seconds) => `思考中…\n\n<font color="grey">已用时 ${seconds}s · 输入 /why 查看实时状态</font>`
clock = 30_000
assert.equal(cadence.push(sameStatus(30)).length, 1, '第一次在 30 秒')
clock = 60_000
assert.equal(cadence.push(sameStatus(60)).length, 0, '间隔不足 180 秒时不重复')
clock = 210_000
assert.equal(cadence.push(sameStatus(210)).length, 1, '下一个间隔照常提醒')
clock = 390_000
assert.equal(cadence.push(sameStatus(390)).length, 1, '第三次提醒')
clock = 570_000
assert.equal(cadence.push(sameStatus(570)).length, 0, '到 progressMax 就停')

// 4. The interval is a knob: default 30 s, configurable, 0 turns progress off.
clock = 0
const boundary = createTextStream({ now: () => clock })
boundary.begin()
clock = 29_000
assert.deepEqual(boundary.push(progressLine('pwsh', 1, 29)), [], '30 秒之前不打扰')
clock = 30_000
assert.equal(boundary.push(progressLine('pwsh', 1, 30)).length, 1)

assert.equal(TEXT_STREAM_LIMITS.progressFirstMs, 30_000)
assert.equal(streamLimitsFromConfig({}).progressFirstMs, 30_000)
assert.equal(streamLimitsFromConfig({ textProgressSeconds: 90 }).progressFirstMs, 90_000)
assert.equal(streamLimitsFromConfig({ textProgressSeconds: 0 }).progressMax, 0, '0 = 关闭进度气泡')
assert.equal(streamLimitsFromConfig({ textProgressSeconds: 0 }).progressFirstMs, Number.POSITIVE_INFINITY)
assert.equal(streamLimitsFromConfig({ textProgressSeconds: 'nonsense' }).progressFirstMs, 30_000)
assert.equal(streamLimitsFromConfig({ textProgressSeconds: -5 }).progressFirstMs, 30_000)


// 5. Answer text: the first slice goes out early, at a sentence end when there
//    is one, so the chat shows the answer instead of a long silence.
const early = createTextStream({ now: () => { clock = 0; return clock } })
early.begin()
assert.deepEqual(early.push('好的，我来看一下这个文件。'), [], '一句话还不够触发首片')
const longFirst = `${'甲'.repeat(70)}。${'乙'.repeat(20)}`
let actions = early.push(longFirst)
assert.equal(actions.length, 1)
assert.ok(actions[0].text.endsWith('。'))
assert.ok(actions[0].text.length <= longFirst.length)

// 5. Paragraph boundaries: a completed paragraph is its own message once it is
//    long enough; a short one waits.
const para = createTextStream()
para.begin()
const body = `${'A'.repeat(90)}\n\n${'B'.repeat(10)}`
actions = para.push(body)
assert.equal(actions.length, 1)
assert.ok(actions[0].text.startsWith('A'.repeat(90)))
assert.ok(!actions[0].text.includes('B'))

// 6. Sentence boundaries only count once the slice is long enough.
const sentence = createTextStream()
sentence.begin()
const text = `${'甲'.repeat(170)}。${'乙'.repeat(20)}`
actions = sentence.push(text)
assert.equal(actions.length, 1)
assert.equal(actions[0].text.length, 171)

// 7. A fenced code block is never cut while it is open.
const code = createTextStream()
code.begin()
assert.deepEqual(code.push('```js\n' + 'x'.repeat(400)), [], 'fence open: wait')
actions = code.push('```js\n' + 'x'.repeat(400) + '\n```')
assert.equal(actions.length, 1)
assert.match(actions[0].text, /x{400}/)
assert.ok(actions[0].text.includes('```'), '代码块以围栏形式整块发出')

// 8. Repeating the same cumulative text emits nothing.
const repeat = createTextStream()
repeat.begin()
const once = repeat.push('乙'.repeat(200))
assert.equal(once.length, 1)
assert.deepEqual(repeat.push('乙'.repeat(200)), [])

// 9. Short text is flushed on finish, then typing turns off; a finished stream
//    ignores later pushes.
const tail = createTextStream()
tail.begin()
assert.deepEqual(tail.push('收到'), [])
const finished = tail.finish('收到')
assert.deepEqual(finished.map((action) => action.kind), ['send', 'typing'])
assert.equal(finished[0].text, '收到')
assert.equal(finished[1].on, false)
assert.deepEqual(tail.push('又来了'), [])

// 10. The message budget holds: a huge answer stops at the chat character
//     budget and hands the tail over (for a file or a note) instead of flooding
//     the chat with forty bubbles.
const huge = createTextStream()
huge.begin()
const hugeFinish = huge.finish('丙'.repeat(20_000))
const sends = hugeFinish.filter((action) => action.kind === 'send')
const tailAction = hugeFinish.find((action) => action.kind === 'truncated')
assert.ok(sends.length <= TEXT_STREAM_LIMITS.maxAnswerMessages)
assert.ok(sends.every((action) => action.text.length <= TEXT_STREAM_LIMITS.maxSegmentChars))
assert.equal(sends.reduce((sum, action) => sum + action.text.length, 0), TEXT_STREAM_LIMITS.maxChatChars)
assert.equal(tailAction.remaining, 20_000 - TEXT_STREAM_LIMITS.maxChatChars)
assert.equal(tailAction.text.length, tailAction.remaining)

// 11. Progress never exceeds the per-turn budget either.
const noisy = createTextStream({ now: () => clock })
noisy.begin()
let progressBubbles = 0
for (let at = 50_000; at <= 20 * 60_000; at += 200_000) {
  clock = at
  progressBubbles += noisy.push(progressLine(`tool${at}`, 1, at / 1000)).length
}
assert.equal(progressBubbles, TEXT_STREAM_LIMITS.progressMax)

// 12. Once answer text has started, status bubbles stop: the chat is no longer
//     silent, so a progress line would only interrupt the reading.
const afterAnswer = createTextStream({ now: () => clock })
afterAnswer.begin()
clock = 10_000
assert.equal(afterAnswer.push(progressLine('pwsh', 1, 10)).length, 0)
clock = 20_000
assert.equal(afterAnswer.push('第一段回答已经够长了，先说结论：这是网关的超时，不是插件的问题。').length, 1)
clock = 200_000
assert.deepEqual(afterAnswer.push(progressLine('pwsh', 4, 200)), [], '作答中不再插进度气泡')

console.log('text-stream: all assertions passed')
