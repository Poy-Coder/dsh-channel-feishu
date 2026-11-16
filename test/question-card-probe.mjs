/**
 * Question-card probe: builds the card the channel would post for each step of a
 * batch and validates it against the real CardKit API (dry run by default).
 *
 * Usage: node test/question-card-probe.mjs [--send] [--exercise] [chatId]
 *
 *   --send      post every step card to the chat (the channel posts one card per
 *               question; a probe has no pending question, so a click on it only
 *               returns the "already finished" toast)
 *   --exercise  rewrite the multi-select tick line and the status line of the
 *               last card, proving element updates land (they fail with 300309
 *               when the card was created without streaming_mode)
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const creds = JSON.parse(readFileSync(join(HOME, 'feishu-channel.json'), 'utf8'))
const BASE = creds.region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
const argv = process.argv.slice(2)
const shouldSend = argv.includes('--send')
const exercise = argv.includes('--exercise')
const CHAT = argv.find((value) => value.startsWith('oc_')) || creds.defaultChatId || ''
const say = (...args) => console.log(...args)

const { questionCardJson } = await import('../index.js')

const questions = [
  {
    id: 'long',
    header: '折叠测试',
    question: '八项选择：前三项直接铺开，其余收进折叠面板。',
    options: Array.from({ length: 8 }, (_, at) => ({
      label: `选项 ${at + 1}`,
      description: at < 2 ? `第 ${at + 1} 项的说明文字` : '',
    })),
    multiSelect: false,
  },
  {
    id: 'extra',
    header: '多选：附加内容',
    question: '回答时还想带上哪些信息？（可多选）',
    options: [
      { label: '截图', description: '附带界面截图' },
      { label: '日志', description: '附带运行日志' },
      { label: '都不要', description: '只回结论' },
      { label: '一起发', description: '截图和日志都要' },
    ],
    multiSelect: true,
  },
]
const callId = `probe-${Date.now()}`

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

const total = questions.length
const sent = []
for (const [index, question] of questions.entries()) {
  const card = questionCardJson({
    callId,
    questions: [question],
    selections: [new Set()],
    offset: index,
    title: total > 1 ? `第 ${index + 1}/${total} 题` : undefined,
    note: '版式预览 · 点击只会提示已结束',
  })
  const created = await api('POST', '/open-apis/cardkit/v1/cards', { type: 'card_json', data: JSON.stringify(card) })
  const cardId = created.payload?.data?.card_id
  say(`card ${index + 1}:`, created.status, cardId ? 'ok' : JSON.stringify(created.payload).slice(0, 240))
  if (!cardId) continue
  if (!shouldSend || !CHAT) {
    sent.push({ step: index, cardId, messageId: '' })
    continue
  }
  const posted = await api('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: CHAT,
    msg_type: 'interactive',
    content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
  })
  say(`send ${index + 1}:`, posted.status)
  sent.push({ step: index, cardId, messageId: posted.payload?.data?.message_id ?? '' })
}

if (!shouldSend) {
  say('dry run only; pass --send to post the step cards to', CHAT)
}

if (exercise) {
  const last = sent.at(-1)
  if (last?.cardId) {
    const tick = await api('PUT', `/open-apis/cardkit/v1/cards/${last.cardId}/elements/qa_sel_1/content`, {
      content: '<font color="grey">已选：日志、截图</font>',
      sequence: 1,
    })
    say('update tick:', tick.status, JSON.stringify(tick.payload).slice(0, 160))
    const note = await api('PUT', `/open-apis/cardkit/v1/cards/${last.cardId}/elements/qa_note/content`, {
      content: '<font color="grey">已选择：截图、日志</font>',
      sequence: 2,
    })
    say('update note:', note.status, JSON.stringify(note.payload).slice(0, 160))
  }
}

say('RESULT', JSON.stringify({ sent }))
