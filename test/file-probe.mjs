/**
 * Feishu attachment probe (diagnostic): upload a small image and a small text
 * file, then send both to the configured chat and print every response.
 *
 * Verifies the two upload endpoints (`im/v1/images`, `im/v1/files`) and the
 * `interactive`-free message types `image` / `file` before the plugin adopts them.
 *
 * Usage: node test/file-probe.mjs [chatId]
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

// 1x1 transparent PNG
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const txt = Buffer.from('DSH 附件测试：这张是文本文件。\n', 'utf8')
say('png bytes:', png.length, 'txt bytes:', txt.length)

async function upload(path, form) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  const payload = await response.json().catch(() => undefined)
  return { status: response.status, payload }
}

// --- image upload -----------------------------------------------------------
const imageForm = new FormData()
imageForm.append('image_type', 'message')
imageForm.append('image', new Blob([png], { type: 'image/png' }), 'dsh-probe.png')
const image = await upload('/open-apis/im/v1/images', imageForm)
say('upload image:', image.status, JSON.stringify(image.payload).slice(0, 300))
const imageKey = image.payload?.data?.image_key

// --- file upload -----------------------------------------------------------
const fileForm = new FormData()
fileForm.append('file_type', 'stream')
fileForm.append('file_name', 'dsh-probe.txt')
fileForm.append('file', new Blob([txt], { type: 'text/plain' }), 'dsh-probe.txt')
const file = await upload('/open-apis/im/v1/files', fileForm)
say('upload file:', file.status, JSON.stringify(file.payload).slice(0, 300))
const fileKey = file.payload?.data?.file_key

if (!CHAT) {
  say('no chat: uploads only')
  process.exit(0)
}

async function send(msgType, content) {
  const response = await fetch(`${BASE}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: CHAT, msg_type: msgType, content: JSON.stringify(content) }),
  })
  const payload = await response.json().catch(() => undefined)
  say(`send ${msgType}:`, response.status, JSON.stringify(payload).slice(0, 300))
  return payload?.data?.message_id
}

if (imageKey) await send('image', { image_key: imageKey })
if (fileKey) await send('file', { file_key: fileKey })
say('RESULT', JSON.stringify({ imageKey, fileKey }))
