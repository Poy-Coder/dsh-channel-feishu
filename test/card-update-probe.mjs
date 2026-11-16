/**
 * Card-update probe: proves that a CardKit card may only update an element's
 * content while its streaming mode is open. The question card used to be created
 * without `streaming_mode`, so every status/selection update failed with
 * `300309 streaming mode is closed`.
 *
 * Usage: node test/card-update-probe.mjs [chatId]
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
if (!token) {
  say('token FAILED')
  process.exit(1)
}

const api = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => undefined)
  return { status: response.status, payload }
}

const buildCard = (title, streaming) => ({
  schema: '2.0',
  config: {
    ...(streaming ? { streaming_mode: true } : {}),
    update_multi: true,
    width_mode: 'fill',
    summary: { content: title },
  },
  header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
  body: {
    elements: [
      { tag: 'markdown', element_id: 'probe_note', content: '初始状态' },
    ],
  },
})

for (const [label, streaming] of [['without streaming_mode', false], ['with streaming_mode', true]]) {
  const card = buildCard(`更新探针 ${streaming ? 'B' : 'A'}`, streaming)
  const created = await api('POST', '/open-apis/cardkit/v1/cards', { type: 'card_json', data: JSON.stringify(card) })
  const cardId = created.payload?.data?.card_id
  say(label, 'create:', created.status, cardId ? 'ok' : JSON.stringify(created.payload).slice(0, 200))
  if (!cardId) continue
  if (CHAT) {
    const sent = await api('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
      receive_id: CHAT, msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
    })
    say(label, 'send:', sent.status)
  }
  const updated = await api('PUT', `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/probe_note/content`, {
    content: '已更新 ✓', sequence: 1,
  })
  say(label, 'update:', updated.status, JSON.stringify(updated.payload).slice(0, 220))
  if (streaming) {
    const closed = await api('PATCH', `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`, {
      settings: JSON.stringify({ config: { streaming_mode: false } }), sequence: 2,
    })
    say(label, 'close:', closed.status, JSON.stringify(closed.payload).slice(0, 160))
  }
}
