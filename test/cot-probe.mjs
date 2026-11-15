/**
 * Feishu thinking-process (CoT) + reaction probe (diagnostic).
 *
 * Verifies that this self-built app may open a CoT run, append AG-UI events,
 * close it with RUN_FINISHED, and add/remove a message reaction.
 *
 * Usage: node test/cot-probe.mjs [chatId]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const creds = JSON.parse(readFileSync(join(HOME, 'feishu-channel.json'), 'utf8'))
const BASE = creds.region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
const CHAT = process.argv[2] || creds.defaultChatId || ''
const say = (...args) => console.log(...args)

const tokenResponse = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
})
const token = (await tokenResponse.json())?.tenant_access_token
say('token:', token ? 'ok' : 'FAILED')
if (!token) process.exit(1)

const api = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => undefined)
  return { status: response.status, payload }
}

// --- 1. open a thinking process -------------------------------------------
const created = await api('POST', '/open-apis/im/v1/message_cot?receive_id_type=chat_id', {
  receive_id: CHAT,
  cot_hidden: false,
  enable_badge: false,
  update_feed_rank: false,
})
say('create cot:', created.status, JSON.stringify(created.payload).slice(0, 300))
const cotId = created.payload?.data?.cot_id
const messageId = created.payload?.data?.message_id
if (!cotId || !messageId) {
  say('cannot continue without cot_id/message_id')
  process.exit(0)
}

// --- 2. append AG-UI events ------------------------------------------------
let stamp = Date.now()
const ev = (event_type, content) => {
  stamp = Math.max(stamp + 1, Date.now())
  return { event_type, content: JSON.stringify(content), timestamp: String(stamp) }
}
const events = [
  ev('RUN_STARTED', { threadId: CHAT, runId: 'probe-run' }),
  ev('REASONING_MESSAGE_START', { messageId: 'reasoning-probe', role: 'reasoning' }),
  ev('REASONING_MESSAGE_CONTENT', { messageId: 'reasoning-probe', delta: '正在读取上下文…' }),
  ev('REASONING_MESSAGE_END', { messageId: 'reasoning-probe' }),
  ev('TOOL_CALL_START', { toolCallId: 'call-probe', icon: 'default', title: '查看日志', toolCallName: 'read' }),
  ev('TOOL_CALL_ARGS', { toolCallId: 'call-probe', delta: '{"path":"feishu-inbound.log"}' }),
  ev('TOOL_CALL_END', { toolCallId: 'call-probe' }),
  ev('TOOL_CALL_RESULT', { messageId: 'result-probe', toolCallId: 'call-probe', role: 'tool', content: { type: 'code', code: 'ok' } }),
  ev('RUN_FINISHED', { threadId: CHAT, runId: 'probe-run', status: 'done' }),
]
const written = await api('PUT', '/open-apis/im/v1/message_cot', { events, message_id: messageId, cot_id: cotId })
say('write events:', written.status, JSON.stringify(written.payload).slice(0, 300))

// --- 3. reaction add / remove on the bot's own message ----------------------
const query = await api('GET', `/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(CHAT)}&page_size=1`)
const targetMessageId = query.payload?.data?.items?.[0]?.message_id
say('reaction target:', targetMessageId ?? '(none)')
if (targetMessageId) {
  const added = await api('POST', `/open-apis/im/v1/messages/${encodeURIComponent(targetMessageId)}/reactions`, {
    reaction_type: { emoji_type: 'THINKING' },
  })
  say('add reaction:', added.status, JSON.stringify(added.payload).slice(0, 240))
  const reactionId = added.payload?.data?.reaction_id
  if (reactionId) {
    const removed = await api('DELETE', `/open-apis/im/v1/messages/${encodeURIComponent(targetMessageId)}/reactions/${encodeURIComponent(reactionId)}`)
    say('remove reaction:', removed.status, JSON.stringify(removed.payload).slice(0, 200))
  }
}
say('RESULT', JSON.stringify({ cotId, messageId }))
