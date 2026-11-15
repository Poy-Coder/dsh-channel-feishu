/**
 * Hermetic unit tests for the question-card helpers. No network, no DSH.
 *
 * Usage: node test/question-cards.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'feishu-question-'))

const {
  QA_STATUS_ELEMENT_ID,
  applyQuestionSelection,
  isQuestionComplete,
  parseQuestionText,
  questionAnswersOf,
  questionCardJson,
} = await import('../index.js')
const { normalizeCardAction } = await import('../providers/feishu.js')

const questions = [
  {
    id: 'mode',
    header: '选择模式',
    question: '用哪种方式实现？',
    detail: '卡片按钮最直观。',
    options: [
      { label: '交互卡片（推荐）', description: '点击即答' },
      { label: '纯文本', description: '回复序号' },
    ],
    multiSelect: false,
  },
]

// 1. Card JSON: schema 2.0, one callback button per option, a status element.
const card = questionCardJson({ callId: 'call-1', questions, note: '等待你的回答…' })
assert.equal(card.schema, '2.0')
assert.equal(card.header.title.content, '需要你的回答')
const elements = card.body.elements
assert.ok(elements.some((element) => element.tag === 'markdown' && element.content.includes('用哪种方式实现')))
const row = elements.find((element) => element.tag === 'column_set')
assert.ok(row, 'option row is missing')
const buttonValues = row.columns.flatMap((column) => column.elements.map((button) => button.behaviors[0].value))
assert.deepEqual(buttonValues, [
  { c: 'call-1', q: 0, o: 0 },
  { c: 'call-1', q: 0, o: 1 },
  { c: 'call-1', q: 0, skip: true },
])
assert.ok(elements.some((element) => element.element_id === QA_STATUS_ELEMENT_ID))
assert.match(row.columns[0].elements[0].text.content, /交互卡片/)

// Multi-select adds a 提交 button, and a free-text question has no button row.
const multi = questionCardJson({
  callId: 'call-2',
  questions: [{ id: 'tags', question: '选几个', options: [{ label: '甲' }, { label: '乙' }], multiSelect: true }],
})
const multiRow = multi.body.elements.find((element) => element.tag === 'column_set')
const multiValues = multiRow.columns.flatMap((column) => column.elements.map((button) => button.behaviors[0].value))
assert.ok(multiValues.some((value) => value.submit === true))
const freeText = questionCardJson({ callId: 'call-3', questions: [{ id: 'name', question: '叫什么？' }] })
assert.equal(freeText.body.elements.some((element) => element.tag === 'column_set'), false)

// 2. Text replies: index, label (recommendation suffix stripped), custom, skip.
assert.deepEqual(parseQuestionText('2', questions), [{ id: 'mode', selected: ['纯文本'] }])
assert.deepEqual(parseQuestionText('交互卡片', questions), [{ id: 'mode', selected: ['交互卡片（推荐）'] }])
assert.deepEqual(parseQuestionText('交互卡片（推荐）', questions), [{ id: 'mode', selected: ['交互卡片（推荐）'] }])
assert.deepEqual(parseQuestionText('跳过', questions), [{ id: 'mode', selected: [] }])
assert.deepEqual(parseQuestionText('随便聊聊', questions), null)
assert.deepEqual(parseQuestionText('1', freeTextQuestions()), [{ id: 'mode', selected: [], custom: '1' }])
assert.deepEqual(parseQuestionText('张三', [{ id: 'name', question: '叫什么？' }]), [{ id: 'name', selected: [], custom: '张三' }])
assert.equal(parseQuestionText('1', [...questions, { id: 'other', question: '第二个' }]), null)

function freeTextQuestions() {
  return [{ id: 'mode', question: '用哪种方式实现？' }]
}

// 3. Button values drive selections; completeness follows the question mode.
const pending = {
  callId: 'call-1',
  questions,
  selections: [new Set()],
  skipped: new Set(),
  submitted: new Set(),
}
assert.equal(applyQuestionSelection(pending, { c: 'other', q: 0, o: 0 }), false)
assert.equal(applyQuestionSelection(pending, { c: 'call-1', q: 0, o: 9 }), false)
assert.equal(isQuestionComplete(pending), false)
assert.equal(applyQuestionSelection(pending, { c: 'call-1', q: 0, o: 1 }), true)
assert.equal(isQuestionComplete(pending), true)
assert.deepEqual(questionAnswersOf(pending), [{ id: 'mode', selected: ['纯文本'] }])

const multiPending = {
  callId: 'call-2',
  questions: [{ id: 'tags', question: '选几个', options: [{ label: '甲' }, { label: '乙' }], multiSelect: true }],
  selections: [new Set()],
  skipped: new Set(),
  submitted: new Set(),
}
assert.equal(applyQuestionSelection(multiPending, { c: 'call-2', q: 0, o: 0 }), true)
assert.equal(applyQuestionSelection(multiPending, { c: 'call-2', q: 0, o: 1 }), true)
assert.equal(isQuestionComplete(multiPending), false)
assert.equal(applyQuestionSelection(multiPending, { c: 'call-2', q: 0, submit: true }), true)
assert.equal(isQuestionComplete(multiPending), true)
assert.deepEqual(questionAnswersOf(multiPending), [{ id: 'tags', selected: ['甲', '乙'] }])

const skipPending = {
  callId: 'call-3',
  questions: [{ id: 'q', question: 'x', options: [{ label: 'a' }] }],
  selections: [new Set()],
  skipped: new Set(),
  submitted: new Set(),
}
assert.equal(applyQuestionSelection(skipPending, { c: 'call-3', q: 0, skip: true }), true)
assert.equal(isQuestionComplete(skipPending), true)
assert.deepEqual(questionAnswersOf(skipPending), [{ id: 'q', selected: [] }])

// 4. Card action payloads: both flattened (dispatcher) and nested shapes work.
const flattened = normalizeCardAction({
  header: { event_type: 'card.action.trigger' },
  operator: { open_id: 'ou_1' },
  action: { value: { c: 'call-1', q: 0, o: 0 }, tag: 'button' },
  context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
})
assert.deepEqual(flattened, {
  messageId: 'om_1',
  chatId: 'oc_1',
  operatorId: 'ou_1',
  value: { c: 'call-1', q: 0, o: 0 },
})
assert.equal(normalizeCardAction({ event: { context: { open_message_id: 'om_1' }, action: {} } }), null)
assert.equal(normalizeCardAction({}), null)

console.log('question-cards: all assertions passed')
