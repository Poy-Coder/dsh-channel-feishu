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
  QA_SELECTION_ELEMENT_PREFIX,
  QA_STATUS_ELEMENT_ID,
  applyQuestionSelection,
  isQuestionComplete,
  isStepSettled,
  parseQuestionText,
  questionAnswersOf,
  questionCardJson,
  questionSelectionText,
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
// Options queue as bare full-width buttons: one block each, never a shared row.
const buttons = elements.filter((element) => element.tag === 'button')
assert.deepEqual(buttons.map((button) => button.behaviors[0].value), [
  { c: 'call-1', q: 0, o: 0 },
  { c: 'call-1', q: 0, o: 1 },
  { c: 'call-1', q: 0, skip: true },
])
assert.ok(buttons.every((button) => button.width === 'fill'), 'every button must fill the card width')
assert.ok(elements.some((element) => element.element_id === QA_STATUS_ELEMENT_ID))
assert.match(buttons[0].text.content, /交互卡片/)
assert.equal(elements.some((element) => element.tag === 'column_set'), false)
// Option descriptions and the reply hint are a notation-sized footnote block.
const finePrint = elements.find((element) => element.text_size === 'notation' && element.element_id === undefined)
assert.ok(finePrint, 'fine print block is missing')
assert.match(finePrint.content, /点击即答/)
assert.match(finePrint.content, /回复序号/)

// Multi-select pairs 提交 with 跳过 in the action row, and a free-text question
// has no buttons at all.
const multi = questionCardJson({
  callId: 'call-2',
  questions: [{ id: 'tags', question: '选几个', options: [{ label: '甲' }, { label: '乙' }], multiSelect: true }],
})
const multiButtons = multi.body.elements.filter((element) => element.tag === 'button')
assert.deepEqual(multiButtons.map((button) => button.behaviors[0].value), [
  { c: 'call-2', q: 0, o: 0 },
  { c: 'call-2', q: 0, o: 1 },
])
const actionRow = multi.body.elements.find((element) => element.tag === 'column_set')
assert.equal(actionRow.columns.length, 2)
assert.deepEqual(actionRow.columns.map((column) => column.elements[0].text.content), ['提交', '跳过'])
// A multi-select question mirrors its ticks in a dedicated, patchable element:
// button text itself cannot be rewritten, and the note alone hides the choice.
const tickLine = multi.body.elements.find((element) => element.element_id === `${QA_SELECTION_ELEMENT_PREFIX}0`)
assert.ok(tickLine, 'selection mirror element is missing')
assert.match(tickLine.content, /已选：无/)
assert.match(questionSelectionText({ options: [{ label: '甲' }, { label: '乙' }] }, new Set([1])), /已选：乙/)
assert.match(questionSelectionText({ options: [{ label: '甲' }, { label: '乙' }] }, new Set([1, 0])), /甲、乙/)
const freeText = questionCardJson({ callId: 'call-3', questions: [{ id: 'name', question: '叫什么？' }] })
assert.equal(freeText.body.elements.some((element) => element.tag === 'button'), false)

// Element writes only succeed while the card's streaming mode is open.
assert.equal(card.config.streaming_mode, true)

// A long option list folds its tail into a collapsible panel: three rows stay
// visible, everything past the third folds.
const many = questionCardJson({
  callId: 'call-4',
  questions: [{ id: 'pick', question: '选一个', options: Array.from({ length: 8 }, (_, at) => ({ label: `选项${at + 1}` })) }],
})
const topButtons = many.body.elements.filter((element) => element.tag === 'button')
assert.equal(topButtons.length, 4) // three options plus 跳过
const panel = many.body.elements.find((element) => element.tag === 'collapsible_panel')
assert.ok(panel, 'collapsible panel is missing')
assert.equal(panel.expanded, false)
assert.ok(panel.header.title.content.includes('其余 5 项（点击展开 / 收起）'))
assert.deepEqual(panel.elements.map((button) => button.behaviors[0].value), [
  { c: 'call-4', q: 0, o: 3 },
  { c: 'call-4', q: 0, o: 4 },
  { c: 'call-4', q: 0, o: 5 },
  { c: 'call-4', q: 0, o: 6 },
  { c: 'call-4', q: 0, o: 7 },
])

// Block order inside one question: options (folded) → 说明 → 提交/跳过.
const finePrintIndex = many.body.elements.findIndex((element) => element.text_size === 'notation' && element.element_id === undefined)
const thirdOptionIndex = many.body.elements.findIndex((element) => element.tag === 'button' && element.text.content.startsWith('3.'))
const skipIndex = many.body.elements.findIndex((element) => element.tag === 'button' && element.text.content === '跳过')
assert.ok(thirdOptionIndex >= 0 && skipIndex >= 0)
assert.ok(finePrintIndex > thirdOptionIndex, '说明 must sit below the option buttons')
assert.ok(skipIndex > finePrintIndex, '提交/跳过 must close the block')

// A stepped card carries the question's batch offset so a click maps back to
// the right question of the batch.
const stepped = questionCardJson({
  callId: 'call-5',
  offset: 1,
  title: '第 2/2 题',
  questions: [{ id: 'second', question: '第二个问题', options: [{ label: '甲' }, { label: '乙' }] }],
})
assert.equal(stepped.header.title.content, '第 2/2 题')
assert.deepEqual(stepped.body.elements.filter((element) => element.tag === 'button').map((button) => button.behaviors[0].value), [
  { c: 'call-5', q: 1, o: 0 },
  { c: 'call-5', q: 1, o: 1 },
  { c: 'call-5', q: 1, skip: true },
])

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

// A batch is asked one step at a time: settling the first question must not
// settle the batch.
const steppedBatch = {
  callId: 'call-9',
  questions: [
    { id: 'first', question: '第一个', options: [{ label: '甲' }, { label: '乙' }] },
    { id: 'second', question: '第二个', options: [{ label: '丙' }, { label: '丁' }] },
  ],
  selections: [new Set(), new Set()],
  skipped: new Set(),
  submitted: new Set(),
  step: 0,
}
assert.equal(isStepSettled(steppedBatch, 0), false)
assert.equal(applyQuestionSelection(steppedBatch, { c: 'call-9', q: 0, o: 1 }), true)
assert.equal(isStepSettled(steppedBatch, 0), true)
assert.equal(isQuestionComplete(steppedBatch), false)
steppedBatch.step = 1
assert.equal(applyQuestionSelection(steppedBatch, { c: 'call-9', q: 1, o: 0 }), true)
assert.equal(isQuestionComplete(steppedBatch), true)
assert.deepEqual(questionAnswersOf(steppedBatch), [
  { id: 'first', selected: ['乙'] },
  { id: 'second', selected: ['丙'] },
])

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
