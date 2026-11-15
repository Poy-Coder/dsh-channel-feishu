/**
 * CardKit live probe (diagnostic, not part of the plugin).
 *
 * Verifies, against the real tenant, that this app can:
 *   1. create a card entity (POST /open-apis/cardkit/v1/cards)
 *   2. send it as an interactive message referencing card_id
 *   3. stream cumulative text into one element (PUT .../elements/:id/content)
 *   4. close streaming and commit the final card (card settings)
 *
 * Credentials come from ~/.dsh/feishu-channel.json (same file the plugin reads).
 * Usage: node test/card-probe.mjs [chatId]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const creds = JSON.parse(readFileSync(join(HOME, 'feishu-channel.json'), 'utf8'))
const BASE = creds.region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
const CHAT = process.argv[2] || creds.defaultChatId || ''
const say = (...args) => console.log(...args)

async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch { payload = { raw: text } }
  return { status: response.status, payload }
}

const tokenPayload = await api('/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST',
  body: { app_id: creds.appId, app_secret: creds.appSecret },
})
const token = tokenPayload.payload?.tenant_access_token
say('token:', token ? 'ok' : `FAILED ${JSON.stringify(tokenPayload.payload)}`)
if (!token) process.exit(1)

const card = {
  schema: '2.0',
  config: {
    streaming_mode: true,
    update_multi: true,
    summary: { content: 'DSH 卡片流式测试' },
  },
  body: {
    elements: [
      { tag: 'markdown', element_id: 'md_1', content: '**DSH 卡片流式测试**\n\n正在建立…' },
    ],
  },
}

const created = await api('/open-apis/cardkit/v1/cards', {
  method: 'POST',
  token,
  body: { type: 'card_json', data: JSON.stringify(card) },
})
say('create card:', created.status, JSON.stringify(created.payload))
const cardId = created.payload?.data?.card_id
if (!cardId) process.exit(2)

if (!CHAT) {
  say('no chatId: skipping send/stream/finalize (pass one as argv[2])')
  process.exit(0)
}

const sent = await api('/open-apis/im/v1/messages?receive_id_type=chat_id', {
  method: 'POST',
  token,
  body: {
    receive_id: CHAT,
    msg_type: 'interactive',
    content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
  },
})
say('send card message:', sent.status, JSON.stringify(sent.payload))
const messageId = sent.payload?.data?.message_id

let sequence = 0
for (const text of ['正在建立…', '正在建立…\n\n第一段流式内容 ✅', '正在建立…\n\n第一段流式内容 ✅\n\n第二段流式内容 ✅']) {
  sequence += 1
  const updated = await api(`/open-apis/cardkit/v1/cards/${cardId}/elements/md_1/content`, {
    method: 'PUT',
    token,
    body: { content: text, sequence },
  })
  say(`stream seq=${sequence}:`, updated.status, JSON.stringify(updated.payload))
  await new Promise((resolve) => setTimeout(resolve, 300))
}

sequence += 1
const closed = await api(`/open-apis/cardkit/v1/cards/${cardId}/settings`, {
  method: 'PATCH',
  token,
  body: { settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: 'DSH 卡片流式测试完成' } } }), sequence },
})
say('close streaming:', closed.status, JSON.stringify(closed.payload))

say('\nRESULT', JSON.stringify({ cardId, messageId, chatId: CHAT }))
