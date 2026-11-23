/**
 * `answerMode: native` — the card shows only progress; each step's answer leaves as
 * its own rich-text message.
 *
 * Why this test exists: the whole point of the mode is that the answer is NOT in the
 * card. A regression that quietly writes it back into the card would still "work" in
 * every other test, so this one asserts on both sides — the card content and the
 * messages sent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-native-answer-'))
process.env.DSH_HOME = home
const logFile = join(home, 'native-inbound.log')

const { apply, observeSessionEvent, registerProvider } = await import('../index.js')

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const sent = { posts: [], texts: [], cardWrites: [], cardClosed: [] }

registerProvider('native', () => ({
  id: 'native',
  label: 'Native',
  settings: () => ({ appId: '', appSecret: '', defaultChatId: 'oc_native', region: 'feishu', baseUrl: '' }),
  settingsAsync: async () => ({ appId: '', appSecret: '', defaultChatId: 'oc_native', region: 'feishu', baseUrl: '' }),
  async sendText({ text }) { sent.texts.push(text); return { ok: true, messageId: `om_text_${sent.texts.length}` } },
  async sendRichText({ post }) { sent.posts.push(post); return { ok: true, messageId: `om_post_${sent.posts.length}` } },
  async removeReaction() {},
  parseInbound: () => null,
  card: {
    async create() { return 'card_native' },
    async attach() { return 'om_card' },
    async update({ content, elementId }) { sent.cardWrites.push({ content, elementId }); await sleep(1) },
    async close({ sequence, summary }) { sent.cardClosed.push(summary); await sleep(1) },
  },
}))

const ctx = { tools: { register: () => () => {} }, logger: { warn() {} }, get: () => undefined }

const baseConfig = {
  provider: 'native',
  enabled: true,
  inboundEnabled: false,
  thinking: false,
  sessionId: 'session-native',
  defaultChatId: 'oc_native',
  logFile,
  streamingCards: true,
}

const session = { id: 'session-native' }
const event = (type, data) => ({ type, data })

// The provider is resolved by `apply`, exactly as a real row does it.
apply(ctx, baseConfig)

test('native mode: each step answer is sent as its own post message', async () => {
  sent.posts.length = 0
  sent.texts.length = 0
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('turn/start', { turn: 1 }))
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('assistant/message', {
    turn: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '第一步：我先看目录结构。' }] },
  }))
  await sleep(30)
  assert.equal(sent.posts.length, 1, '一步就是一条消息')
  const flat = JSON.stringify(sent.posts[0])
  assert.ok(flat.includes('第一步'), '正文必须出现在 post 里')
})

test('native mode: the card never receives the answer text', async () => {
  sent.cardWrites.length = 0
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('turn/start', { turn: 2 }))
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('assistant/message', {
    turn: 2,
    message: { role: 'assistant', content: [{ type: 'text', text: '这一段只应该出现在消息里，不该进卡片。' }] },
  }))
  await sleep(60)
  const cardText = sent.cardWrites.map((write) => String(write.content ?? '')).join('\n')
  assert.equal(cardText.includes('不该进卡片'), false, '卡片只放进度，不放正文')
})

test('closing a native turn flips the footer and never writes an empty body', async () => {
  sent.cardWrites.length = 0
  sent.cardClosed.length = 0
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('turn/start', { turn: 8 }))
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('assistant/message', {
    turn: 8,
    message: { role: 'assistant', content: [{ type: 'text', text: '这一步的正文。' }] },
  }))
  await sleep(40)
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('turn/end', {
    turn: 8,
    reason: { kind: 'ok' },
  }))
  await sleep(120)

  // Feishu rejects an empty element body (99992402), which used to abort the close
  // and leave the card stuck on 回复中.
  for (const write of sent.cardWrites) {
    assert.notEqual(String(write.content ?? ''), '', '不能写空内容，飞书会拒绝')
  }
  const footers = sent.cardWrites.filter((write) => write.elementId === 'note_1').map((write) => write.content)
  assert.ok(footers.some((content) => /完成/.test(String(content))), 'footer 必须翻成完成')
  assert.equal(sent.cardClosed.length, 1, '卡片必须关闭')
  assert.ok(sent.cardClosed[0], 'summary 不能为空')
})

test('card mode is unchanged: the answer still goes into the card', async () => {
  sent.cardWrites.length = 0
  sent.posts.length = 0
  observeSessionEvent(ctx, baseConfig, session, event('turn/start', { turn: 3 }))
  observeSessionEvent(ctx, baseConfig, session, event('assistant/message', {
    turn: 3,
    message: { role: 'assistant', content: [{ type: 'text', text: '默认模式仍然写入卡片。' }] },
  }))
  await sleep(60)
  const cardText = sent.cardWrites.map((write) => String(write.content ?? '')).join('\n')
  assert.ok(cardText.includes('默认模式仍然写入卡片'), '默认行为不能变')
  assert.equal(sent.posts.length, 0, '默认模式不发 post')
})

test('a step with no text sends nothing', async () => {
  sent.posts.length = 0
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('turn/start', { turn: 4 }))
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('assistant/message', {
    turn: 4,
    message: { role: 'assistant', content: [] },
  }))
  await sleep(30)
  assert.equal(sent.posts.length, 0)
})

test('native mode: closing the turn does not replay the answer into the card', async () => {
  sent.cardWrites.length = 0
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('turn/start', { turn: 6 }))
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('assistant/message', {
    turn: 6,
    message: { role: 'assistant', content: [{ type: 'text', text: '这一步的正文已经发出去了。' }] },
  }))
  await sleep(40)
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('turn/end', {
    turn: 6,
    reason: { kind: 'ok' },
  }))
  await sleep(120)
  const cardText = sent.cardWrites.map((write) => String(write.content ?? '')).join('\n')
  assert.equal(cardText.includes('已经发出去了'), false, '收尾不能把正文重写回卡片')
})

test('native mode: a failed turn is still reported to the chat', async () => {
  sent.texts.length = 0
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('turn/start', { turn: 7 }))
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('assistant/message', {
    turn: 7,
    message: { role: 'assistant', content: [{ type: 'text', text: '出错前已经发出的部分。' }] },
  }))
  await sleep(40)
  observeSessionEvent(ctx, { ...baseConfig, answerMode: 'native' }, session, event('turn/end', {
    turn: 7,
    reason: { kind: 'error', error: { message: 'boom' } },
  }))
  await sleep(150)
  assert.ok(
    sent.texts.some((item) => /出错/.test(item)),
    `失败必须报给聊天，实际发出：${JSON.stringify(sent.texts)}`,
  )
})
