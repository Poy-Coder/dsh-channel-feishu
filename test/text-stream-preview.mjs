/**
 * Prints the WeChat transcript a real turn would produce, using the text-stream
 * engine and a fake clock. No network: this is the design feedback loop.
 *
 * Usage: node test/text-stream-preview.mjs
 */
import { createTextStream } from '../providers/text-stream.js'

let clock = 0
const stream = createTextStream({ now: () => clock })
const out = []
const stamp = (ms) => `[+${String(Math.round(ms / 1000)).padStart(3, ' ')}s]`

function run(actions, ms) {
  for (const action of actions) {
    if (action.kind === 'typing') {
      out.push(`${stamp(ms)} ${action.on ? '（对方正在输入…）' : '（输入状态关闭）'}`)
    } else if (action.kind === 'send') {
      const label = action.tag === 'progress' ? '机器人·进度：' : '机器人：'
      const body = action.text.replace(/\n/g, '\n' + ' '.repeat(24))
      out.push(`${stamp(ms)} ${label}${body}`)
    } else if (action.kind === 'truncated') {
      out.push(`${stamp(ms)} （内容超过条数上限，剩余 ${action.remaining} 字未发）`)
    }
  }
}

const progress = (tool, calls, seconds) =>
  `思考中…\n\n<font color="grey">正在执行 ${tool} · 已调用 ${calls} 个工具 · 已用时 ${seconds}s</font>`

run(stream.begin(), 0)

// The turn runs long tools before the first token.
clock = 20_000; run(stream.push(progress('pwsh', 1, 20)), clock)
clock = 50_000; run(stream.push(progress('pwsh', 2, 50)), clock)
clock = 95_000; run(stream.push(progress('pwsh', 3, 95)), clock)

// Stage 1: the model starts answering, then calls another tool.
let full = '先说结论：这次超时的根因是网关把 30 秒上限卡在了流式请求上，跟插件本身无关。\n\n'
clock = 110_000; run(stream.push(full), clock)

full += '我按三步处理：\n\n1. 复现并抓了 inbound 日志；\n2. 对上了 200850 的流式超时；\n3. 把重试和退避补上。\n\n'
clock = 115_000; run(stream.push(full), clock)

// A tool call produces the next progress line, but the gap since the last
// progress bubble is short, so it is intentionally swallowed.
clock = 130_000; run(stream.push(progress('feishu_send_message', 4, 130)), clock)

// Stage 2: the verification paragraph arrives after a longer silence.
full += '验证结果：连续跑了 20 轮，卡片都能正常关闭，日志里没有再出现 card streaming timeout。\n\n'
clock = 310_000; run(stream.push(full), clock)
clock = 315_000; run(stream.push(progress('pwsh', 5, 315)), clock)

// Final tail: flushed on finish, then typing turns off.
full += '还需要你确认一件事：这套退避参数要不要按你的网络再调一档？'
clock = 320_000; run(stream.finish(full), clock)

console.log(out.join('\n'))
