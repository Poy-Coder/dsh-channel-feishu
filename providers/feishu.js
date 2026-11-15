/**
 * Feishu / Lark transport adapter for the DSH channel framework.
 *
 * Everything that knows about Feishu Open API lives here; `index.js` only owns
 * channel behavior (sessions, workspaces, permissions, titles, turn replies).
 * Adding another IM means adding a sibling file that satisfies the same contract:
 *
 *   create<Provider>Provider(config) -> {
 *     id, label,
 *     settings()                      -> { appId, appSecret, region, baseUrl, defaultChatId }
 *     checkStatus(signal)             -> { configured, tokenOk, ... }
 *     sendText({ chatId, text }, s)   -> { ok, messageId, chatId }
 *     sendAttachment({ chatId, path, name }, s) -> { ok, kind, key, messageId, bytes }
 *     parseInbound(event)             -> { dedupeKey, chatId, senderId, messageId,
 *                                          text, imageKeys, unsupported }
 *     downloadImage({ messageId, imageKey }, s) -> localPath
 *     card.create({ text, summary }, s) / card.attach(...) / card.update(...) / card.close(...)
 *     connect({ onEvent, onState })   -> dispose
 *   }
 *
 * Settings precedence, highest first:
 *   1. the row `config` in cordis.patch.yml (non-empty fields only)
 *   2. the environment (FEISHU_APP_ID / FEISHU_APP_SECRET)
 *   3. the credentials file <DSH_HOME>/feishu-channel.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const REGION_BASE = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
}

const TOKEN_SKEW_MS = 60_000
const FILE_TTL_MS = 5_000
const tokenCache = new Map()
let fileCache = { path: '', readAt: 0, value: {} }

export function credentialsFilePath() {
  const home = String(globalThis.process?.env?.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'feishu-channel.json')
}

function fileSettings() {
  const path = credentialsFilePath()
  const now = Date.now()
  if (fileCache.path === path && now - fileCache.readAt < FILE_TTL_MS) return fileCache.value
  let value = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed
  } catch {
    value = {}
  }
  fileCache = { path, readAt: now, value }
  return value
}

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

/** Merge row config, environment, and the credentials file into one settings view. */
export function resolveSettings(config = {}) {
  const env = globalThis.process?.env ?? {}
  const file = fileSettings()
  const region = firstNonEmpty(config.region, file.region, 'feishu').toLowerCase()
  return {
    appId: firstNonEmpty(config.appId, env.FEISHU_APP_ID, file.appId),
    appSecret: firstNonEmpty(config.appSecret, env.FEISHU_APP_SECRET, file.appSecret),
    defaultChatId: firstNonEmpty(config.defaultChatId, file.defaultChatId),
    region,
    baseUrl: REGION_BASE[region] ?? REGION_BASE.feishu,
  }
}

/**
 * Settings plus the credential-store layer.
 *
 * `ctx.credentials` can hold `FEISHU_APP_ID` / `FEISHU_APP_SECRET` as reference
 * keys, which keeps the secret out of every file; it ranks between the row
 * config and the environment. Resolution is per call, so a rotated stored value
 * applies to the next request without a restart.
 */
export async function resolveSettingsWithCredentials(config = {}, credentials) {
  const base = resolveSettings(config)
  let appId = base.appId
  let appSecret = base.appSecret
  let source = appId || appSecret ? 'config-or-file' : ''
  const resolveKey = async (name) => {
    try {
      const hit = await credentials?.resolve?.(name)
      return String(hit?.value ?? '').trim()
    } catch {
      return ''
    }
  }
  if (!appId) {
    const stored = await resolveKey('FEISHU_APP_ID')
    if (stored) {
      appId = stored
      source = 'credentials'
    }
  }
  if (!appSecret) {
    const stored = await resolveKey('FEISHU_APP_SECRET')
    if (stored) {
      appSecret = stored
      source = 'credentials'
    }
  }
  return { ...base, appId, appSecret, credentialSource: source }
}

function feishuError(payload, fallback) {  const code = payload?.code
  const msg = payload?.msg ?? payload?.message
  if (code === undefined || code === 0) return fallback
  return `Feishu API error ${code}${msg ? `: ${msg}` : ''}`
}

export async function tenantToken(base, appId, appSecret, signal) {
  const cacheKey = `${base}|${appId}`
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.token

  const response = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  const token = payload?.tenant_access_token
  if (!response.ok || !token) {
    throw new Error(`Feishu tenant token request failed (HTTP ${response.status})`
      + `${payload?.msg ? `: ${payload.msg}` : ''}`)
  }
  const expireSec = Number(payload?.expire ?? 7200)
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expireSec * 1000 })
  return token
}

export async function sendTextMessage(base, token, { receiveId, receiveIdType, text }, signal) {
  const query = new URLSearchParams({ receive_id_type: receiveIdType })
  const response = await fetch(`${base}/open-apis/im/v1/messages?${query.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu send failed (HTTP ${response.status})`))
  }
  return {
    ok: true,
    messageId: String(payload?.data?.message_id ?? ''),
    chatId: String(payload?.data?.chat_id ?? (receiveIdType === 'chat_id' ? receiveId : '')),
  }
}

// ---------------------------------------------------------------------------
// Attachments
//
// Feishu wants an upload first — `im/v1/images` for pictures, `im/v1/files` for
// everything else — and then a message that references the returned key. Both
// endpoints take multipart, so the platform FormData/Blob do the encoding.
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const FILE_MAX_BYTES = 30 * 1024 * 1024
const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

const extensionOf = (name) => {
  const dot = String(name ?? '').lastIndexOf('.')
  return dot >= 0 ? String(name).slice(dot + 1).toLowerCase() : ''
}

/** Classify an outgoing file: pictures take the image endpoint, the rest the file one. */
export function attachmentKind(path) {
  return IMAGE_EXTENSIONS.has(extensionOf(path)) ? 'image' : 'file'
}

async function sendByKey(base, token, { receiveId, receiveIdType, msgType, content }, signal) {
  const query = new URLSearchParams({ receive_id_type: receiveIdType })
  const response = await fetch(`${base}/open-apis/im/v1/messages?${query.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu ${msgType} send failed (HTTP ${response.status})`))
  }
  return String(payload?.data?.message_id ?? '')
}

async function uploadImage(base, token, { buffer, name }, signal) {
  if (buffer.length > IMAGE_MAX_BYTES) {
    throw new Error(`image too large: ${buffer.length} bytes (limit ${IMAGE_MAX_BYTES})`)
  }
  const form = new FormData()
  form.append('image_type', 'message')
  form.append('image', new Blob([buffer], { type: MIME_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream' }), name)
  const response = await fetch(`${base}/open-apis/im/v1/images`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  const key = payload?.data?.image_key
  if (!response.ok || !key) throw new Error(feishuError(payload, `Feishu image upload failed (HTTP ${response.status})`))
  return String(key)
}

async function uploadFile(base, token, { buffer, name }, signal) {
  if (buffer.length > FILE_MAX_BYTES) {
    throw new Error(`file too large: ${buffer.length} bytes (limit ${FILE_MAX_BYTES})`)
  }
  const form = new FormData()
  form.append('file_type', 'stream')
  form.append('file_name', name)
  form.append('file', new Blob([buffer], { type: MIME_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream' }), name)
  const response = await fetch(`${base}/open-apis/im/v1/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  const key = payload?.data?.file_key
  if (!response.ok || !key) throw new Error(feishuError(payload, `Feishu file upload failed (HTTP ${response.status})`))
  return String(key)
}

/** Upload one local file and send it as an image or file message. */
export async function sendAttachment(base, token, { path, name }, target, signal) {
  const fileName = String(name ?? '').trim() || basename(String(path ?? ''))
  if (!path) throw new Error('attachment path is required')
  const buffer = readFileSync(String(path))
  if (attachmentKind(fileName) === 'image') {
    const imageKey = await uploadImage(base, token, { buffer, name: fileName }, signal)
    const messageId = await sendByKey(base, token, {
      ...target, msgType: 'image', content: { image_key: imageKey },
    }, signal)
    return { ok: true, kind: 'image', name: fileName, bytes: buffer.length, key: imageKey, messageId }
  }
  const fileKey = await uploadFile(base, token, { buffer, name: fileName }, signal)
  const messageId = await sendByKey(base, token, {
    ...target, msgType: 'file', content: { file_key: fileKey },
  }, signal)
  return { ok: true, kind: 'file', name: fileName, bytes: buffer.length, key: fileKey, messageId }
}

// ---------------------------------------------------------------------------
// Cards (streaming markdown)
// ---------------------------------------------------------------------------

export const CARD_ELEMENT_ID = 'md_1'

function cardJson(text, summary) {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      // The Feishu client animates the text itself, so cumulative PATCHes read
      // as continuous typing instead of one jump per write.
      streaming_config: {
        print_frequency_ms: { default: 40, android: 40, ios: 40, pc: 40 },
        print_step: { default: 1, android: 1, ios: 1, pc: 1 },
        print_strategy: 'fast',
      },
      update_multi: true,
      width_mode: 'fill',
      summary: { content: summary },
    },
    body: {
      elements: [
        { tag: 'markdown', element_id: CARD_ELEMENT_ID, content: text || ' ' },
        { tag: 'hr' },
        {
          tag: 'markdown',
          element_id: 'note_1',
          content: '<font color="grey">流式输出中</font>',
          text_size: 'notation',
        },
      ],
    },
  }
}

export async function createCard(base, token, { text, summary }, signal) {
  const response = await fetch(`${base}/open-apis/cardkit/v1/cards`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ type: 'card_json', data: JSON.stringify(cardJson(text, summary)) }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  const cardId = payload?.data?.card_id
  if (!response.ok || !cardId) {
    throw new Error(feishuError(payload, `Feishu card create failed (HTTP ${response.status})`))
  }
  return String(cardId)
}

export async function sendCard(base, token, { receiveId, receiveIdType, cardId }, signal) {
  const query = new URLSearchParams({ receive_id_type: receiveIdType })
  const response = await fetch(`${base}/open-apis/im/v1/messages?${query.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
    }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu card send failed (HTTP ${response.status})`))
  }
  return String(payload?.data?.message_id ?? '')
}

export async function updateCardText(base, token, { cardId, content, sequence, elementId = CARD_ELEMENT_ID }, signal) {
  const response = await fetch(
    `${base}/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content, sequence }),
      signal,
    },
  )
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu card update failed (HTTP ${response.status})`))
  }
}

export async function closeCard(base, token, { cardId, sequence, summary }, signal) {
  const response = await fetch(`${base}/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }),
      sequence,
    }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu card finalize failed (HTTP ${response.status})`))
  }
}

// ---------------------------------------------------------------------------
// Inbound parsing
// ---------------------------------------------------------------------------

/** Parse a Feishu text message body (`message.content` is a JSON string). */
export function parseTextContent(content) {
  try {
    const parsed = JSON.parse(content ?? '{}')
    return typeof parsed?.text === 'string' ? parsed.text : ''
  } catch {
    return ''
  }
}

/** Remove @mention placeholders (`@_user_1`) that Feishu puts in text bodies. */
export function stripMentions(text, mentions) {
  let out = String(text ?? '')
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const key = mention?.key
    if (typeof key === 'string' && key) out = out.split(key).join(' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}

const POST_MAX_CHARS = 8000

/**
 * Parse a Feishu rich-text (`post`) body into plain text plus image keys.
 *
 * Shape: `{ title, content: [[{ tag: 'text'|'a'|'img'|..., ... }]] }`, sometimes
 * wrapped per locale (`{ zh_cn: { title, content } }`). Only text is kept; an
 * `img` node contributes its `image_key` so the caller can download it.
 */
export function parsePostContent(content) {
  let parsed
  try {
    parsed = JSON.parse(content ?? '{}')
  } catch {
    return { text: '', imageKeys: [] }
  }
  if (!parsed || typeof parsed !== 'object') return { text: '', imageKeys: [] }
  const body = Array.isArray(parsed.content)
    ? parsed
    : (Object.values(parsed).find((value) => value && Array.isArray(value.content)) ?? parsed)
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const lines = []
  const imageKeys = []
  for (const paragraph of Array.isArray(body?.content) ? body.content : []) {
    if (!Array.isArray(paragraph)) continue
    let line = ''
    for (const node of paragraph) {
      const tag = String(node?.tag ?? '')
      if (tag === 'img') {
        const key = typeof node?.image_key === 'string' ? node.image_key : ''
        if (key) imageKeys.push(key)
        continue
      }
      if (typeof node?.text === 'string') line += node.text
    }
    if (line.trim()) lines.push(line.trim())
  }
  return { text: [title, ...lines].filter(Boolean).join('\n').slice(0, POST_MAX_CHARS), imageKeys }
}

/** Parse a single-image message body (`{"image_key":"img_..."}`). */
export function parseImageContent(content) {
  try {
    const parsed = JSON.parse(content ?? '{}')
    return typeof parsed?.image_key === 'string' ? parsed.image_key : ''
  } catch {
    return ''
  }
}

/** Where inbound attachments land; override with `inboundFilesDir` in the row config. */
export function inboundFilesDir(config) {
  const configured = String(config?.inboundFilesDir ?? '').trim()
  if (configured) return configured
  return join(dirname(credentialsFilePath()), 'feishu-inbound-files')
}

/** Sniff the container format so the agent can open the file by extension. */
export function imageExtension(buffer) {
  if (buffer.length >= 12
    && buffer.toString('latin1', 0, 4) === 'RIFF'
    && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 3) === 'GIF') return 'gif'
  return 'bin'
}

/**
 * Download one message image through the message-resource endpoint.
 *
 * The plain `/im/v1/images/:image_key` endpoint rejects keys that belong to a
 * chat message ("Invalid request param", code 234001); the message-resource
 * route is the one that works with `im:message` scope.
 */
export async function downloadMessageImage(base, token, messageId, imageKey, config, signal) {
  const resource = `${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`
    + `/resources/${encodeURIComponent(imageKey)}?type=image`
  const response = await fetch(resource, { headers: { authorization: `Bearer ${token}` }, signal })
  if (!response.ok) throw new Error(`Feishu image download failed (HTTP ${response.status})`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const dir = inboundFilesDir(config)
  mkdirSync(dir, { recursive: true })
  const name = `${messageId}-${imageKey.slice(-10)}.${imageExtension(buffer)}`
  const path = join(dir, name)
  writeFileSync(path, buffer)
  return path
}

/** Normalize one `im.message.receive_v1` payload; null means "nothing usable". */
export function parseInboundEvent(event) {
  const message = event?.message
  const sender = event?.sender
  if (!message || !sender) return null
  const messageType = String(message.message_type ?? '')
  const mentions = message.mentions
  let text = ''
  let imageKeys = []
  if (messageType === 'text') {
    text = stripMentions(parseTextContent(message.content), mentions)
  } else if (messageType === 'post') {
    const parsed = parsePostContent(message.content)
    text = stripMentions(parsed.text, mentions)
    imageKeys = parsed.imageKeys
  } else if (messageType === 'image') {
    const key = parseImageContent(message.content)
    if (key) imageKeys = [key]
  } else {
    return {
      dedupeKey: String(event?.header?.event_id ?? ''),
      chatId: String(message.chat_id ?? ''),
      senderId: String(sender.sender_id?.open_id ?? ''),
      senderType: String(sender.sender_type ?? ''),
      messageId: String(message.message_id ?? ''),
      text: '',
      imageKeys: [],
      unsupported: messageType,
    }
  }
  return {
    dedupeKey: String(event?.header?.event_id ?? ''),
    chatId: String(message.chat_id ?? ''),
    senderId: String(sender.sender_id?.open_id ?? ''),
    senderType: String(sender.sender_type ?? ''),
    messageId: String(message.message_id ?? ''),
    text,
    imageKeys,
    unsupported: '',
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Build the Feishu adapter.
 * `log` receives `{ event, result, reason, ... }` records for feishu-inbound.log.
 */
export function createFeishuProvider(config = {}, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const settings = () => resolveSettings(config)
  const settingsAsync = () => resolveSettingsWithCredentials(config, deps.credentials)
  const token = async (signal) => {
    const resolved = await settingsAsync()
    return tenantToken(resolved.baseUrl, resolved.appId, resolved.appSecret, signal)
  }

  return {
    id: 'feishu',
    label: 'Feishu / Lark',
    settings,
    settingsAsync,

    async checkStatus(signal) {
      const resolved = await settingsAsync()
      const result = {
        configured: Boolean(resolved.appId && resolved.appSecret),
        tokenOk: false,
        region: resolved.region,
        baseUrl: resolved.baseUrl,
        appId: resolved.appId,
        defaultChatId: resolved.defaultChatId,
        credentialSource: resolved.credentialSource ?? '',
        error: '',
      }
      if (!result.configured) {
        result.error = 'missing appId/appSecret (row config, credentials store, env, or credentials file)'
        return result
      }
      try {
        await tenantToken(resolved.baseUrl, resolved.appId, resolved.appSecret, signal)
        result.tokenOk = true
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
      }
      return result
    },

    async sendText({ chatId, text }, signal) {
      const resolved = await settingsAsync()
      return await sendTextMessage(resolved.baseUrl, await token(signal), {
        receiveId: chatId, receiveIdType: 'chat_id', text,
      }, signal)
    },

    async sendAttachment({ chatId, path, name }, signal) {
      const resolved = await settingsAsync()
      return await sendAttachment(
        resolved.baseUrl,
        await token(signal),
        { path, name },
        { receiveId: chatId, receiveIdType: 'chat_id' },
        signal,
      )
    },

    parseInbound: parseInboundEvent,

    async downloadImage({ messageId, imageKey }, signal) {
      const resolved = await settingsAsync()
      return await downloadMessageImage(
        resolved.baseUrl, await token(signal), messageId, imageKey, config, signal,
      )
    },

    card: {
      async create({ text, summary }, signal) {
        const resolved = await settingsAsync()
        return await createCard(resolved.baseUrl, await token(signal), { text, summary }, signal)
      },
      async attach({ chatId, cardId }, signal) {
        const resolved = await settingsAsync()
        return await sendCard(resolved.baseUrl, await token(signal), {
          receiveId: chatId, receiveIdType: 'chat_id', cardId,
        }, signal)
      },
      async update({ cardId, content, sequence, elementId }, signal) {
        const resolved = await settingsAsync()
        await updateCardText(resolved.baseUrl, await token(signal), { cardId, content, sequence, elementId }, signal)
      },
      async close({ cardId, sequence, summary }, signal) {
        const resolved = await settingsAsync()
        await closeCard(resolved.baseUrl, await token(signal), { cardId, sequence, summary }, signal)
      },
    },

    // --- thinking process (native CoT) -------------------------------------
    // One POST opens the run, PUT appends AG-UI events, RUN_FINISHED closes it.
    async cotCreate({ chatId, replyTo, hidden = false }, signal) {
      const resolved = await settingsAsync()
      const response = await fetch(`${resolved.baseUrl}/open-apis/im/v1/message_cot?receive_id_type=chat_id`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${await token(signal)}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          ...(replyTo ? { origin_message_id: replyTo } : {}),
          cot_hidden: hidden,
          enable_badge: false,
          update_feed_rank: false,
        }),
        signal,
      })
      const payload = await response.json().catch(() => undefined)
      const cotId = payload?.data?.cot_id
      const messageId = payload?.data?.message_id
      if (!response.ok || !cotId || !messageId) {
        throw new Error(feishuError(payload, `Feishu CoT create failed (HTTP ${response.status})`))
      }
      return { cotId: String(cotId), messageId: String(messageId) }
    },

    async cotWrite({ cotId, messageId, events }, signal) {
      const resolved = await settingsAsync()
      const response = await fetch(`${resolved.baseUrl}/open-apis/im/v1/message_cot`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${await token(signal)}`,
        },
        body: JSON.stringify({ events, message_id: messageId, cot_id: cotId }),
        signal,
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
        throw new Error(feishuError(payload, `Feishu CoT write failed (HTTP ${response.status})`))
      }
    },

    // --- reactions ----------------------------------------------------------
    async addReaction({ messageId, emoji = 'THINKING' }, signal) {
      const resolved = await settingsAsync()
      const response = await fetch(
        `${resolved.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${await token(signal)}`,
          },
          body: JSON.stringify({ reaction_type: { emoji_type: emoji } }),
          signal,
        },
      )
      const payload = await response.json().catch(() => undefined)
      const reactionId = payload?.data?.reaction_id
      if (!response.ok || !reactionId) {
        throw new Error(feishuError(payload, `Feishu reaction add failed (HTTP ${response.status})`))
      }
      return String(reactionId)
    },

    async removeReaction({ messageId, reactionId }, signal) {
      const resolved = await settingsAsync()
      const response = await fetch(
        `${resolved.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${await token(signal)}` },
          signal,
        },
      )
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
        throw new Error(feishuError(payload, `Feishu reaction remove failed (HTTP ${response.status})`))
      }
    },

    /**
     * Long connection: the Feishu SDK owns reconnect, auth and decryption.
     * `onEvent(data)` receives one `im.message.receive_v1` payload;
     * `onState({ ready, error })` publishes transport health.
     */
    async connect({ onEvent, onState }, signal) {
      const resolved = await settingsAsync()
      if (!resolved.appId || !resolved.appSecret) {
        onState?.({ ready: false, error: 'missing appId/appSecret' })
        return () => {}
      }
      let Lark
      try {
        const mod = await import('@larksuiteoapi/node-sdk')
        Lark = mod?.default?.WSClient ? mod.default : mod
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        onState?.({ ready: false, error: `cannot load @larksuiteoapi/node-sdk: ${reason}` })
        log({ event: 'channel', result: 'sdk-missing', reason })
        return () => {}
      }

      let client
      let disposed = false
      try {
        const dispatcher = new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data) => {
            try {
              await onEvent(data)
            } catch (error) {
              log({ event: 'channel', result: 'handler-failed', reason: error instanceof Error ? error.message : String(error) })
            }
          },
        })
        client = new Lark.WSClient({
          appId: resolved.appId,
          appSecret: resolved.appSecret,
          loggerLevel: Lark.LoggerLevel?.info,
        })
        await client.start({ eventDispatcher: dispatcher })
        if (disposed) {
          try { client.close() } catch { /* already closing */ }
        } else {
          onState?.({ ready: true, error: '' })
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        onState?.({ ready: false, error: reason })
        log({ event: 'channel', result: 'connect-failed', reason })
      }

      return () => {
        disposed = true
        try { client?.close?.() } catch { /* ignore */ }
        onState?.({ ready: false, error: 'closed' })
      }
    },
  }
}
