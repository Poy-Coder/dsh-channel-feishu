/**
 * Hermetic tests for the WeChat (iLink) provider: settings precedence, inbound
 * normalization, media decrypt, send/typing, text-stream cards, and the
 * long-poll loop. All HTTP is stubbed, so this runs offline.
 *
 * Usage: node test/wechat-provider.mjs
 */
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'feishu-wechat-'))
process.env.DSH_HOME = home
process.env.WECHAT_ACCOUNT_ID = ''
process.env.WECHAT_BOT_TOKEN = ''

writeFileSync(join(home, 'wechat-channel.json'), JSON.stringify({
  botToken: 'file-token', accountId: 'file-bot@im.bot', userId: 'user@im.wechat', baseUrl: 'https://ilink.test',
}))

const { createWechatProvider, resolveWechatSettings, decryptMedia, parseAesKey } = await import('../providers/wechat.js')

// ---------------------------------------------------------------------------
// Fake iLink server
// ---------------------------------------------------------------------------
const calls = []
let updates = []
let failNextSend = false
let respondStaleOnce = false
const json = (payload, headers = {}) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const pngCipher = (() => {
  const plain = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const cipher = Buffer.concat([createCipheriv('aes-128-ecb', key, null).update(plain), createCipheriv('aes-128-ecb', key, null).final()])
  return { cipher, key, plain }
})()

globalThis.fetch = async (url, init = {}) => {
  const text = typeof init.body === 'string' ? init.body : ''
  const body = text ? JSON.parse(text) : undefined
  calls.push({ url: String(url), body })
  const path = new URL(String(url)).pathname
  if (path.endsWith('/ilink/bot/getconfig')) return json({ ret: 0, typing_ticket: 'ticket-1' })
  if (path.endsWith('/ilink/bot/sendtyping')) return json({ ret: 0 })
  if (path.endsWith('/ilink/bot/sendmessage')) {
    if (failNextSend) { failNextSend = false; return json({ ret: 100, errmsg: 'context token expired' }) }
    return json({ ret: 0, message_id: `srv_${calls.length}` })
  }
  if (path.endsWith('/ilink/bot/msg/notifystart')) return json({ ret: 0 })
  if (path.endsWith('/ilink/bot/getuploadurl')) return json({ ret: 0, upload_param: 'up-param' })
  if (path.endsWith('/upload')) return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl-param' } })
  if (path.endsWith('/download')) return new Response(pngCipher.cipher, { status: 200 })
  if (path.endsWith('/ilink/bot/getupdates')) {
    if (respondStaleOnce) { respondStaleOnce = false; return json({ ret: -14, errmsg: 'stale token' }) }
    const batch = updates
    updates = []
    return json({ ret: 0, get_updates_buf: 'cursor-1', msgs: batch })
  }
  return json({ ret: -1, errmsg: `unexpected ${path}` })
}

// ---------------------------------------------------------------------------
// 1. Settings precedence: row config > env > credentials file
// ---------------------------------------------------------------------------
let settings = resolveWechatSettings({})
assert.equal(settings.configured, true)
assert.equal(settings.botToken, 'file-token')
assert.equal(settings.accountId, 'file-bot@im.bot')
assert.equal(settings.baseUrl, 'https://ilink.test')
assert.equal(settings.defaultChatId, 'user@im.wechat')

process.env.WECHAT_BOT_TOKEN = 'env-token'
settings = resolveWechatSettings({})
assert.equal(settings.botToken, 'env-token')
settings = resolveWechatSettings({ botToken: 'row-token', baseUrl: 'https://row.test/' })
assert.equal(settings.botToken, 'row-token')
assert.equal(settings.baseUrl, 'https://row.test')
delete process.env.WECHAT_BOT_TOKEN

// ---------------------------------------------------------------------------
// 2. AES: padded and unpadded payloads both decode
// ---------------------------------------------------------------------------
const key = parseAesKey('00112233445566778899aabbccddeeff')
assert.equal(key.length, 16)
assert.deepEqual(decryptMedia(pngCipher.cipher, key), pngCipher.plain)
// 2b. 64-bit ids must not go through Number: a 19-digit message_id would round
// and two different messages could share one dedupe key.
const { parseWeixinJson } = await import('../providers/wechat.js')
const rawIds = '{"ret":0,"msgs":[{"message_id":18446744073709551615,"item_list":[{"type":1,"msg_id":12345678901234567890}]}]}'
const parsedIds = parseWeixinJson(rawIds)
assert.equal(parsedIds.msgs[0].message_id, '18446744073709551615')
assert.equal(typeof parsedIds.msgs[0].message_id, 'string')
assert.equal(parsedIds.msgs[0].item_list[0].msg_id, '12345678901234567890')
assert.deepEqual(parseWeixinJson(''), {})

// ---------------------------------------------------------------------------
// 3. Inbound: text, image key registration, context token, typing
// ---------------------------------------------------------------------------
const provider = createWechatProvider({}, { log: () => {} })
const inbound = provider.parseInbound({
  message_id: 7527956516348258,
  from_user_id: 'user@im.wechat',
  context_token: 'ctx-1',
  session_id: 's1',
  item_list: [
    { type: 1, text_item: { text: '你好' } },
    { type: 2, image_item: { aeskey: pngCipher.key.toString('hex'), media: { full_url: 'https://fake.cdn/download?x=1', aes_key: 'ignored' } } },
  ],
})
assert.equal(inbound.chatId, 'user@im.wechat')
assert.equal(inbound.senderId, 'user@im.wechat')
assert.equal(inbound.dedupeKey, '7527956516348258')
assert.equal(inbound.text, '你好')
assert.equal(inbound.imageKeys.length, 1)
assert.equal(inbound.unsupported, '')
// Group messages are out of scope for v1 and are dropped loudly.
const groupInbound = provider.parseInbound({ message_id: 9001, from_user_id: 'user@im.wechat', chattype: 'group', chatid: 'group@chatroom', item_list: [{ type: 1, text_item: { text: 'hi all' } }] })
assert.equal(groupInbound.unsupported, 'chat:group')
assert.equal(groupInbound.text, '')
// A quoted message is folded into the prompt, using only what the protocol
// carries (title + quoted items); an id-only quote still marks the context.
const quotedInbound = provider.parseInbound({
  message_id: 8001,
  from_user_id: 'user@im.wechat',
  context_token: 'ctx-1',
  item_list: [{
    type: 1,
    text_item: { text: '看这个' },
    ref_msg: { title: '之前的消息', message_item: { item_list: [{ type: 1, text_item: { text: '原始内容' } }] } },
  }],
})
assert.equal(quotedInbound.text, '引用：之前的消息 | 原始内容\n\n看这个')
const idOnlyQuote = provider.parseInbound({
  message_id: 8002,
  from_user_id: 'user@im.wechat',
  context_token: 'ctx-1',
  item_list: [{ type: 1, text_item: { text: '这个呢' }, ref_msg: { svr_id: '123' } }],
})
assert.equal(idOnlyQuote.text, '引用：[引用消息]\n\n这个呢')

const savedPath = await provider.downloadImage({ messageId: inbound.messageId, imageKey: inbound.imageKeys[0] })
assert.deepEqual(readFileSync(savedPath), pngCipher.plain)

// ---------------------------------------------------------------------------
// 4. sendText echoes the context token and uses the bot message envelope
// ---------------------------------------------------------------------------
const sent = await provider.sendText({ chatId: 'user@im.wechat', text: '收到：你好' })
assert.equal(sent.ok, true)
const sendCall = calls.filter((call) => call.url.endsWith('/ilink/bot/sendmessage')).at(-1)
assert.equal(sendCall.body.msg.to_user_id, 'user@im.wechat')
assert.equal(sendCall.body.msg.message_type, 2)
assert.equal(sendCall.body.msg.message_state, 2)
assert.equal(sendCall.body.msg.context_token, 'ctx-1')
assert.equal(sendCall.body.msg.item_list[0].type, 1)
assert.equal(sendCall.body.msg.item_list[0].text_item.text, '收到：你好')
assert.match(sendCall.body.msg.client_id, /^dsh-wechat-/)
assert.equal(sendCall.body.base_info.channel_version, '2.4.10')
// 4b. Long text is split on paragraph boundaries, and a stale context token is
// retried once without it instead of dropping the reply.
const { splitForWechat } = await import('../providers/wechat.js')
assert.deepEqual(splitForWechat('short'), ['short'])
const long = '第一段内容'.repeat(80) + '\n\n' + '第二段内容'.repeat(80) + '\n\n' + '第三段内容'.repeat(80)
const parts = splitForWechat(long, 300)
assert.ok(parts.length >= 2)
assert.ok(parts.every((part) => part.length <= 300))
assert.equal(parts.join('').replace(/\s/g, ''), long.replace(/\s/g, ''), '切片不丢字')

failNextSend = true
const beforeRetry = calls.length
const retried = await provider.sendText({ chatId: 'user@im.wechat', text: 'retry me' })
assert.equal(retried.ok, true)
const retryCalls = calls.slice(beforeRetry).filter((call) => call.url.endsWith('/ilink/bot/sendmessage'))
assert.equal(retryCalls.length, 2)
assert.equal(retryCalls[0].body.msg.context_token, 'ctx-1')
assert.equal(retryCalls[1].body.msg.context_token, undefined, '过期 token 的重试不再携带它')
// A fresh inbound message re-issues a context token (as WeChat does).
provider.parseInbound({ message_id: 7002, from_user_id: 'user@im.wechat', context_token: 'ctx-3', item_list: [{ type: 1, text_item: { text: 'again' } }] })

// ---------------------------------------------------------------------------
// 5. checkStatus: token is validated with notifystart
// ---------------------------------------------------------------------------
const status = await provider.checkStatus()
assert.equal(status.configured, true)
assert.equal(status.tokenOk, true)
assert.equal(status.defaultChatId, 'user@im.wechat')

// ---------------------------------------------------------------------------
// 6. Attachment out: upload then a file message item
// ---------------------------------------------------------------------------
const filePath = join(home, 'note.txt')
writeFileSync(filePath, 'hello wechat')
const attachment = await provider.sendAttachment({ chatId: 'user@im.wechat', path: filePath, name: 'note.txt' })
assert.equal(attachment.ok, true)
assert.equal(attachment.kind, 'file')
const uploadCall = calls.filter((call) => call.url.endsWith('/ilink/bot/getuploadurl')).at(-1)
assert.equal(uploadCall.body.media_type, 3)
assert.equal(uploadCall.body.to_user_id, 'user@im.wechat')
const fileSend = calls.filter((call) => call.url.endsWith('/ilink/bot/sendmessage')).at(-1)
assert.equal(fileSend.body.msg.item_list[0].type, 4)
assert.equal(fileSend.body.msg.item_list[0].file_item.file_name, 'note.txt')
assert.equal(fileSend.body.msg.item_list[0].file_item.len, '12')
assert.match(fileSend.body.msg.item_list[0].file_item.media.encrypt_query_param, /dl-param/)

// ---------------------------------------------------------------------------
// 7. Cards are a text stream: typing on, progress suppressed, answer sent,
//    finish flushes and turns typing off.
// ---------------------------------------------------------------------------
const before = calls.length
const cardId = await provider.card.create({ text: '思考中…', summary: 't' })
await provider.card.attach({ chatId: 'user@im.wechat', cardId })
let typingCalls = calls.slice(before).filter((call) => call.url.endsWith('/ilink/bot/sendtyping'))
assert.equal(typingCalls.length, 1, 'attach starts the typing indicator')

await provider.card.update({ cardId, content: '思考中…\n\n<font color="grey">正在执行 pwsh · 已调用 1 个工具 · 已用时 5s</font>' })
assert.equal(calls.slice(before).filter((call) => call.url.endsWith('/ilink/bot/sendmessage')).length, 0, 'progress under the threshold stays silent')

// Card-chrome writes (the 流式输出中 footer carries an elementId) must never
// become chat messages: the plain-text stream only follows answer content.
await provider.card.update({ cardId, content: '<font color="grey">流式输出中</font>', elementId: 'note_1' })
assert.equal(calls.slice(before).filter((call) => call.url.endsWith('/ilink/bot/sendmessage')).length, 0, '元素更新不发消息')
const answer = '先给结论：这是网关的超时问题，不是插件本身的问题。\n\n我按三步处理，第一步是对上日志里的 200850 错误码。'
await provider.card.update({ cardId, content: answer })
assert.equal(calls.slice(before).filter((call) => call.url.endsWith('/ilink/bot/sendmessage')).length, 0, '回合中不发正文')

await provider.card.update({ cardId, content: `${answer}\n\n补一句：日志里没有其它错误。` })
assert.equal(calls.slice(before).filter((call) => call.url.endsWith('/ilink/bot/sendmessage')).length, 0, '正文不分段')

await provider.card.close({ cardId, summary: 'done' })
const answerSends = calls.slice(before).filter((call) => call.url.endsWith('/ilink/bot/sendmessage'))
assert.equal(answerSends.length, 1, '一轮只发一条完整消息')
assert.equal(answerSends[0].body.msg.message_state, 2, '唯一的帧是 FINISH')
assert.match(answerSends[0].body.msg.item_list[0].text_item.text, /^先给结论/)
assert.match(answerSends[0].body.msg.item_list[0].text_item.text, /补一句：日志里没有其它错误/)
typingCalls = calls.slice(before).filter((call) => call.url.endsWith('/ilink/bot/sendtyping'))
assert.equal(typingCalls.at(-1).body.status, 2, 'close cancels typing')
assert.equal(typingCalls.at(-1).body.ilink_user_id, 'user@im.wechat')

// A card-less channel rejects raw cards so the framework falls back to text.
await assert.rejects(() => provider.card.createRaw({ card: {} }))

// ---------------------------------------------------------------------------
// 8. connect(): one batch is delivered, state goes ready
// ---------------------------------------------------------------------------
updates = [{ message_id: 1, from_user_id: 'user@im.wechat', context_token: 'ctx-2', item_list: [{ type: 1, text_item: { text: 'hi' } }] }]
const delivered = []
const states = []
const dispose = await provider.connect({
  onEvent: async (message) => { delivered.push(message) },
  onState: (state) => { states.push(state) },
})
await new Promise((resolve) => setTimeout(resolve, 50))
dispose()
assert.ok(states.some((state) => state.ready === true), 'ready state reported')
assert.equal(delivered.length, 1)
assert.equal(delivered[0].message_id, 1)
// 8b. Cursor persistence, lifecycle pings and the -14 pause.
const { existsSync } = await import('node:fs')
const { loadWechatCursor, wechatSyncFilePath, _resetWechatPauseForTest } = await import('../providers/wechat.js')
assert.ok(existsSync(wechatSyncFilePath()), 'sync cursor file written')
assert.equal(loadWechatCursor('file-bot@im.bot'), 'cursor-1')
assert.ok(calls.some((call) => call.url.endsWith('/ilink/bot/msg/notifystart')), 'notifystart on connect')
await new Promise((resolve) => setTimeout(resolve, 80))
assert.ok(calls.some((call) => call.url.endsWith('/ilink/bot/msg/notifystop')), 'notifystop on dispose')

_resetWechatPauseForTest()
respondStaleOnce = true
const staleStates = []
const disposeStale = await provider.connect({ onEvent: async () => {}, onState: (state) => staleStates.push(state) })
await new Promise((resolve) => setTimeout(resolve, 150))
disposeStale()
assert.ok(staleStates.some((state) => /paused/.test(String(state.error ?? ''))), 'errcode -14 pauses the channel')
await assert.rejects(() => provider.sendText({ chatId: 'user@im.wechat', text: 'x' }), /暂停/)
_resetWechatPauseForTest()

console.log('wechat-provider: all assertions passed')
