/**
 * Card layout probe: verifies a card 2.0 with a header bar, a fill-width body, a
 * divider and a footer element renders and still accepts streaming updates.
 *
 * Usage: node test/card-layout-probe.mjs [chatId]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const creds = JSON.parse(readFileSync(join(HOME, 'feishu-channel.json'), 'utf8'))
const BASE = creds.region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
const CHAT = process.argv[2] || creds.defaultChatId || ''
const say = (...args) => console.log(...args)

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

const card = {
  schema: '2.0',
  config: {
    streaming_mode: true,
    streaming_config: {
      print_frequency_ms: { default: 40, android: 40, ios: 40, pc: 40 },
      print_step: { default: 1, android: 1, ios: 1, pc: 1 },
      print_strategy: 'fast',
    },
    update_multi: true,
    width_mode: 'fill',
    summary: { content: '排版探针' },
  },
  header: {
    title: { tag: 'plain_text', content: 'DSH' },
    subtitle: { tag: 'plain_text', content: '流式回复' },
    template: 'wathet',
  },
  body: {
    elements: [
      { tag: 'markdown', element_id: 'md_1', content: '**排版探针**\n\n正在验证标题栏、宽度与页脚。' },
      { tag: 'hr' },
      { tag: 'markdown', element_id: 'note_1', content: '<font color="grey">DSH · 流式输出中</font>', text_size: 'notation' },
    ],
  },
}

const created = await api('POST', '/open-apis/cardkit/v1/cards', { type: 'card_json', data: JSON.stringify(card) })
say('create card:', created.status, JSON.stringify(created.payload).slice(0, 300))
const cardId = created.payload?.data?.card_id
if (!cardId) process.exit(0)

const sent = await api('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
  receive_id: CHAT,
  msg_type: 'interactive',
  content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
})
say('send:', sent.status, JSON.stringify(sent.payload).slice(0, 200))

for (const [index, text] of ['第一段：标题栏与页脚是否生效', '第一段：标题栏与页脚是否生效\n\n第二段：流式仍在同一张卡内'].entries()) {
  const updated = await api('PUT', `/open-apis/cardkit/v1/cards/${cardId}/elements/md_1/content`, {
    content: text, sequence: index + 1,
  })
  say(`stream ${index + 1}:`, updated.status)
}

const note = await api('PUT', `/open-apis/cardkit/v1/cards/${cardId}/elements/note_1/content`, {
  content: '<font color="grey">DSH · 完成</font>', sequence: 3,
})
say('footer update:', note.status, JSON.stringify(note.payload).slice(0, 200))

const closed = await api('PATCH', `/open-apis/cardkit/v1/cards/${cardId}/settings`, {
  settings: JSON.stringify({ config: { streaming_mode: false, width_mode: 'fill', summary: { content: '排版探针完成' } } }),
  sequence: 4,
})
say('close:', closed.status, JSON.stringify(closed.payload).slice(0, 200))
say('RESULT', JSON.stringify({ cardId }))
