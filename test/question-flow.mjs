/**
 * Hermetic integration test for the Feishu question answerer.
 *
 * A fake provider stands in for the Feishu transport, so this exercises the whole
 * `user-questions/request` path — card build, attach, button click, timeout and
 * the text-reply fallback — without touching the network or a live session.
 *
 * Usage: node test/question-flow.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'feishu-question-flow-'))

const {
  answerUserQuestion,
  apply,
  consumeQuestionTextAnswer,
  handleQuestionCardAction,
  pendingQuestionCount,
  registerProvider,
} = await import('../index.js')
const { normalizeCardAction } = await import('../providers/feishu.js')

const sent = { cards: [], attached: [], updates: [], texts: [] }
let failCards = false

const makeFake = (overrides = {}) => ({
  id: 'fake',
  label: 'Fake',
  settings: () => ({ appId: '', appSecret: '', defaultChatId: 'oc_fake', region: 'feishu', baseUrl: '' }),
  settingsAsync: async () => ({ appId: '', appSecret: '', defaultChatId: 'oc_fake', region: 'feishu', baseUrl: '' }),
  async sendText({ chatId, text }) {
    sent.texts.push({ chatId, text })
    return { ok: true, messageId: `om_text_${sent.texts.length}` }
  },
  card: {
    async createRaw({ card }) {
      if (failCards) throw new Error('card json rejected')
      sent.cards.push(card)
      return `card_${sent.cards.length}`
    },
    async attach({ chatId, cardId }) {
      sent.attached.push({ chatId, cardId })
      return `om_card_${sent.attached.length}`
    },
    async update(args) { sent.updates.push(args) },
  },
  normalizeCardAction,
  parseInbound: () => null,
  ...overrides,
})
registerProvider('fake', () => makeFake())
// A channel without cards (WeChat shape): any unmatched message is the answer.
registerProvider('fake-text', () => makeFake({ id: 'fake-text', label: 'FakeText', freeTextAnswers: true }))

const ctx = {
  tools: { register: () => () => {} },
  logger: { warn() {} },
  get: () => undefined,
}
const config = {
  provider: 'fake',
  enabled: true,
  inboundEnabled: false,
  sessionId: 'session-fake',
  defaultChatId: 'oc_fake',
  questionCards: true,
  questionTimeoutSeconds: 0,
  allowedUsers: ['ou_ok'],
}
apply(ctx, config)

const questions = [
  {
    id: 'mode',
    header: '选择模式',
    question: '用哪种方式实现？',
    options: [{ label: '交互卡片（推荐）' }, { label: '纯文本' }],
    multiSelect: false,
  },
]
const next = async () => ({ answers: 'delegated' })

// 1. Button click answers a single-select question.
const request = {
  agent: { id: 'session-fake' },
  questions,
  wait: { callId: 'call-1' },
  signal: new AbortController().signal,
}
const pendingAnswer = answerUserQuestion(ctx, config, request, next)
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(sent.cards.length, 1, 'question card was not sent')
assert.equal(sent.attached[0].chatId, 'oc_fake')
assert.equal(sent.attached[0].cardId, 'card_1')
// Option labels are markdown; the chips below carry only numbers, and 补充 / 跳过
// share the closing action row.
const isChipRow = (element) => element.tag === 'column_set'
  && element.columns.every((column) => column.elements[0].tag === 'button' && /^\d+$/.test(column.elements[0].text.content))
const chips = sent.cards[0].body.elements.filter(isChipRow).flatMap((row) => row.columns.map((column) => column.elements[0]))
assert.deepEqual(chips.map((chip) => chip.behaviors[0].value), [
  { c: 'call-1', q: 0, o: 0 },
  { c: 'call-1', q: 0, o: 1 },
])
const labels = sent.cards[0].body.elements.find((element) => element.tag === 'markdown' && element.content.startsWith('**1**'))
assert.match(labels.content, /交互卡片（推荐）/)
const actionRow = sent.cards[0].body.elements.find((element) => element.tag === 'column_set'
  && element.columns.some((column) => column.elements[0].text.content === '跳过'))
assert.deepEqual(actionRow.columns.map((column) => column.elements[0].behaviors[0].value), [
  { c: 'call-1', q: 0, other: true },
  { c: 'call-1', q: 0, skip: true },
])

const toast = await handleQuestionCardAction(ctx, config, {
  header: { event_type: 'card.action.trigger' },
  operator: { open_id: 'ou_ok' },
  action: { value: { c: 'call-1', q: 0, o: 1 } },
  context: { open_message_id: 'om_card_1', open_chat_id: 'oc_fake' },
})
assert.equal(toast.toast.type, 'success')
assert.deepEqual(await pendingAnswer, { answers: [{ id: 'mode', selected: ['纯文本'] }] })
assert.equal(pendingQuestionCount(), 0)

// 2. Free-text reply answers the question through the inbound path.
const textRequest = {
  agent: { id: 'session-fake' },
  questions: [{ id: 'name', question: '你叫什么？' }],
  wait: { callId: 'call-2' },
  signal: new AbortController().signal,
}
const textAnswer = answerUserQuestion(ctx, config, textRequest, next)
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(consumeQuestionTextAnswer(ctx, config, { chatId: 'oc_fake', senderId: 'ou_ok', text: '张三' }), true)
assert.deepEqual(await textAnswer, { answers: [{ id: 'name', selected: [], custom: '张三' }] })
// An unrelated message that arrives while no question is pending is delivered normally.
assert.equal(consumeQuestionTextAnswer(ctx, config, { chatId: 'oc_fake', senderId: 'ou_ok', text: '正常消息' }), false)

// 3. A number reply picks an option; an unrelated word while pending is not eaten.
const numberRequest = {
  agent: { id: 'session-fake' },
  questions,
  wait: { callId: 'call-3' },
  signal: new AbortController().signal,
}
const numberAnswer = answerUserQuestion(ctx, config, numberRequest, next)
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(consumeQuestionTextAnswer(ctx, config, { chatId: 'oc_fake', senderId: 'ou_ok', text: '随便聊聊' }), false)
assert.equal(consumeQuestionTextAnswer(ctx, config, { chatId: 'oc_fake', senderId: 'ou_ok', text: '2' }), true)
assert.deepEqual(await numberAnswer, { answers: [{ id: 'mode', selected: ['纯文本'] }] })

// 4. Multi-select: every option toggles, 提交 completes the batch.
const multiConfig = { ...config, questionTimeoutSeconds: 0 }
const multiRequest = {
  agent: { id: 'session-fake' },
  questions: [{
    id: 'tags',
    question: '选几个',
    options: [{ label: '甲' }, { label: '乙' }],
    multiSelect: true,
  }],
  wait: { callId: 'call-4' },
  signal: new AbortController().signal,
}
const multiAnswer = answerUserQuestion(ctx, multiConfig, multiRequest, next)
await new Promise((resolve) => setTimeout(resolve, 20))
const click = (value) => handleQuestionCardAction(ctx, multiConfig, {
  operator: { open_id: 'ou_ok' },
  action: { value },
  context: { open_message_id: sent.attached.at(-1) ? `om_card_${sent.attached.length}` : 'om_card_x', open_chat_id: 'oc_fake' },
})
assert.equal(pendingQuestionCount(), 1)
assert.equal((await click({ c: 'call-4', q: 0, o: 0 })).toast.type, 'success')
assert.equal((await click({ c: 'call-4', q: 0, o: 1 })).toast.type, 'success')
assert.equal((await click({ c: 'call-4', q: 0, submit: true })).toast.type, 'success')
assert.deepEqual(await multiAnswer, { answers: [{ id: 'tags', selected: ['甲', '乙'] }] })

// 5. An unauthorized click is rejected and leaves the question open.
const guardRequest = {
  agent: { id: 'session-fake' },
  questions,
  wait: { callId: 'call-5' },
  signal: new AbortController().signal,
}
const guardAnswer = answerUserQuestion(ctx, multiConfig, guardRequest, next)
await new Promise((resolve) => setTimeout(resolve, 20))
const denied = await handleQuestionCardAction(ctx, multiConfig, {
  operator: { open_id: 'ou_stranger' },
  action: { value: { c: 'call-5', q: 0, o: 0 } },
  context: { open_message_id: 'om_card_1', open_chat_id: 'oc_fake' },
})
assert.equal(denied.toast.type, 'error')
assert.equal(pendingQuestionCount(), 1)
// Finish it so the timeout test starts from a clean state.
await handleQuestionCardAction(ctx, multiConfig, {
  operator: { open_id: 'ou_ok' },
  action: { value: { c: 'call-5', q: 0, o: 0 } },
  context: { open_message_id: 'om_card_1', open_chat_id: 'oc_fake' },
})
assert.deepEqual(await guardAnswer, { answers: [{ id: 'mode', selected: ['交互卡片（推荐）'] }] })

// 6. Timeout settles the tool call with skipped answers instead of hanging it.
const timeoutConfig = { ...config, questionTimeoutSeconds: 1 }
const timeoutAnswer = answerUserQuestion(ctx, timeoutConfig, {
  agent: { id: 'session-fake' },
  questions,
  wait: { callId: 'call-6' },
  signal: new AbortController().signal,
}, next)
// The plugin's timeout timer is unref'd, so a plain wait keeps the loop alive.
await new Promise((resolve) => setTimeout(resolve, 1_500))
assert.deepEqual(await timeoutAnswer, { answers: [{ id: 'mode', selected: [] }] })

// 7. Card creation failure falls back to a plain-text question that still accepts a reply.
failCards = true
const fallbackAnswer = answerUserQuestion(ctx, config, {
  agent: { id: 'session-fake' },
  questions,
  wait: { callId: 'call-7' },
  signal: new AbortController().signal,
}, next)
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(sent.texts.length, 1)
assert.match(sent.texts[0].text, /用哪种方式实现/)
assert.equal(consumeQuestionTextAnswer(ctx, config, { chatId: 'oc_fake', senderId: 'ou_ok', text: '1' }), true)
assert.deepEqual(await fallbackAnswer, { answers: [{ id: 'mode', selected: ['交互卡片（推荐）'] }] })
failCards = false

// 8. Questions for a session the channel never saw are delegated to the next answerer.
const delegated = await answerUserQuestion(ctx, config, {
  agent: { id: 'session-other' },
  questions,
  wait: { callId: 'call-8' },
  signal: new AbortController().signal,
}, next)
assert.deepEqual(delegated, { answers: 'delegated' })

// 9. 补充: the 补充 button arms the free-text path, so a message that matches no
// option still becomes the answer (as custom text). Clicking it twice disarms,
// and an ordinary message must then pass through untouched.
const otherRequest = {
  agent: { id: 'session-fake' },
  questions,
  wait: { callId: 'call-9' },
  signal: new AbortController().signal,
}
const otherAnswer = answerUserQuestion(ctx, config, otherRequest, next)
await new Promise((resolve) => setTimeout(resolve, 20))
const clickOther = (value) => handleQuestionCardAction(ctx, config, {
  operator: { open_id: 'ou_ok' },
  action: { value },
  context: { open_message_id: 'om_card_9', open_chat_id: 'oc_fake' },
})
const armed = await clickOther({ c: 'call-9', q: 0, other: true })
assert.equal(armed.toast.type, 'info')
assert.match(armed.toast.content, /补充/)
// Arming, cancelling, arming again: the last state wins.
assert.equal((await clickOther({ c: 'call-9', q: 0, other: true })).toast.type, 'info')
assert.equal(consumeQuestionTextAnswer(ctx, config, { chatId: 'oc_fake', senderId: 'ou_ok', text: '随便说说' }), false)
assert.equal((await clickOther({ c: 'call-9', q: 0, other: true })).toast.type, 'info')
assert.equal(consumeQuestionTextAnswer(ctx, config, { chatId: 'oc_fake', senderId: 'ou_ok', text: '这两种都不对，我想自己说' }), true)
assert.deepEqual(await otherAnswer, { answers: [{ id: 'mode', selected: [], custom: '这两种都不对，我想自己说' }] })
assert.equal(pendingQuestionCount(), 0)

// 10. A card-less channel (WeChat shape): the question is plain text, a number
// picks an option and any other message is the supplement — no protocol to
// learn and no 「补充」 button to press.
failCards = true
const textConfig = { ...config, provider: 'fake-text' }
apply(ctx, textConfig)
const plainRequest = {
  agent: { id: 'session-fake' },
  questions,
  wait: { callId: 'call-10' },
  signal: new AbortController().signal,
}
const plainAnswer = answerUserQuestion(ctx, textConfig, plainRequest, next)
await new Promise((resolve) => setTimeout(resolve, 20))
const prompt = sent.texts.at(-1).text
assert.match(prompt, /1\. 交互卡片（推荐）/)
assert.match(prompt, /回数字选一个/)
assert.match(prompt, /直接打字补充/)
assert.equal(consumeQuestionTextAnswer(ctx, textConfig, { chatId: 'oc_fake', senderId: 'ou_ok', text: '2' }), true)
assert.deepEqual(await plainAnswer, { answers: [{ id: 'mode', selected: ['纯文本'] }] })

const freeRequest = {
  agent: { id: 'session-fake' },
  questions,
  wait: { callId: 'call-11' },
  signal: new AbortController().signal,
}
const freeAnswer = answerUserQuestion(ctx, textConfig, freeRequest, next)
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(consumeQuestionTextAnswer(ctx, textConfig, {
  chatId: 'oc_fake', senderId: 'ou_ok', text: '两个都不合适，我补充一句',
}), true)
assert.deepEqual(await freeAnswer, {
  answers: [{ id: 'mode', selected: [], custom: '两个都不合适，我补充一句' }],
})
failCards = false

console.log('question-flow: all assertions passed')
