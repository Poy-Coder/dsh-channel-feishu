/**
 * Question-card probe: validates the interactive question card against the real
 * Feishu CardKit API (dry run — the card entity is created but never sent),
 * or sends it to the default chat when called with `--send [chatId]`.
 *
 * Usage: node test/question-card-probe.mjs [--send] [chatId]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const creds = JSON.parse(readFileSync(join(HOME, 'feishu-channel.json'), 'utf8'))
const BASE = creds.region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
const argv = process.argv.slice(2)
const shouldSend = argv.includes('--send')
const CHAT = argv.find((value) => value.startsWith('oc_')) || creds.defaultChatId || ''
const say = (...args) => console.log(...args)

const { questionCardJson } = await import('../index.js')

const questions = [
  {
    id: 'mode',
    header: '选择模式',
    question: '飞书问答卡用哪种交互？',
    detail: '这是探针卡片：点按钮只会返回 toast，不会影响任何会话。',
    options: [
      { label: '按钮（推荐）', description: '点击即答' },
      { label: '文字回复', description: '回复序号' },
    ],
    multiSelect: false,
  },
]
const callId = `probe-${Date.now()}`
const card = questionCardJson({ callId, questions, note: '探针：等待你的回答…' })

const tokenPayload = await (await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
})).json()
const token = tokenPayload.tenant_access_token
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

const created = await api('POST', '/open-apis/cardkit/v1/cards', { type: 'card_json', data: JSON.stringify(card) })
say('create card:', created.status, JSON.stringify(created.payload).slice(0, 300))
const cardId = created.payload?.data?.card_id
if (!cardId) process.exit(0)
if (!shouldSend) {
  say('dry run only; pass --send to post the card to', CHAT)
  say('RESULT', JSON.stringify({ cardId, sent: false }))
  process.exit(0)
}
if (!CHAT) {
  say('no chat id for --send')
  process.exit(1)
}

const sent = await api('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
  receive_id: CHAT,
  msg_type: 'interactive',
  content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
})
say('send:', sent.status, JSON.stringify(sent.payload).slice(0, 300))
const messageId = sent.payload?.data?.message_id
if (!messageId) process.exit(0)

// Reflect an answered state in the status element, exactly like the plugin does.
const patched = await api('PUT', `/open-apis/cardkit/v1/cards/${cardId}/elements/qa_note/content`, {
  content: '<font color="grey">探针：已收到（测试结束）</font>',
  sequence: 1,
})
say('patch note:', patched.status, JSON.stringify(patched.payload).slice(0, 200))
say('RESULT', JSON.stringify({ cardId, messageId, sent: true }))
