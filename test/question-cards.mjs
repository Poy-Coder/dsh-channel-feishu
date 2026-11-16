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

// 1. Card JSON: schema 2.0, option labels as wrapping markdown + numbered chips.
const card = questionCardJson({ callId: 'call-1', questions, note: '等待你的回答…' })
assert.equal(card.schema, '2.0')
assert.equal(card.header.title.content, '需要你的回答')
const elements = card.body.elements
assert.ok(elements.some((element) => element.tag === 'markdown' && element.content.includes('用哪种方式实现')))
// Option labels are their own wrapping markdown block: a button label would be
// cut with an ellipsis on a phone, so the labels never enter a button.
const labelBlock = elements.find((element) => element.tag === 'markdown' && element.content.startsWith('**1**'))
assert.ok(labelBlock, 'option label block is missing')
assert.match(labelBlock.content, /\*\*1\*\*\s+交互卡片（推荐）/)
assert.match(labelBlock.content, /\*\*2\*\*\s+纯文本/)
// The chips below carry only the numbers, one per option.
const isChipRow = (element) => element.tag === 'column_set'
  && element.columns.every((column) => column.elements[0].tag === 'button' && /^\d+$/.test(column.elements[0].text.content))
const chips = elements.filter(isChipRow).flatMap((row) => row.columns.map((column) => column.elements[0]))
assert.deepEqual(chips.map((chip) => chip.text.content), ['1', '2'])
assert.deepEqual(chips.map((chip) => chip.behaviors[0].value), [
  { c: 'call-1', q: 0, o: 0 },
  { c: 'call-1', q: 0, o: 1 },
])
// The action row closes the block: 补充 (free text) then 跳过.
const isActionRow = (element) => element.tag === 'column_set'
  && element.columns.some((column) => ['提交', '补充', '跳过'].includes(column.elements[0].text.content))
const actionRow = elements.find(isActionRow)
assert.ok(actionRow, 'action row is missing')
assert.deepEqual(actionRow.columns.map((column) => column.elements[0].text.content), ['补充', '跳过'])
assert.deepEqual(actionRow.columns.map((column) => column.elements[0].behaviors[0].value), [
  { c: 'call-1', q: 0, other: true },
  { c: 'call-1', q: 0, skip: true },
])
assert.ok(elements.some((element) => element.element_id === QA_STATUS_ELEMENT_ID))

// A long option stays complete: it never passes through a button's single-line
// text, so nothing is sliced to fit and nothing is ellipsized.
const longLabel = '插件详情页 docs/DETAIL.zh.md（推荐，需要发一版才对外可见）'
const longCard = questionCardJson({
  callId: 'call-long',
  questions: [{ id: 'pick', question: '改哪里？', options: [{ label: longLabel }, { label: '两处都加' }] }],
})
const longLabels = longCard.body.elements.find((element) => element.tag === 'markdown' && element.content.startsWith('**1**'))
assert.ok(longLabels.content.includes(longLabel), '长选项的文字必须完整保留')
// Option descriptions and the reply hint are a notation-sized footnote block.
const finePrint = elements.find((element) => element.text_size === 'notation' && element.element_id === undefined)
assert.ok(finePrint, 'fine print block is missing')
assert.match(finePrint.content, /点击即答/)
assert.match(finePrint.content, /补充/)

// Multi-select puts 提交 / 补充 / 跳过 in the action row, and a free-text
// question has no buttons at all.
const multi = questionCardJson({
  callId: 'call-2',
  questions: [{ id: 'tags', question: '选几个', options: [{ label: '甲' }, { label: '乙' }], multiSelect: true }],
})
const multiChips = multi.body.elements.filter(isChipRow).flatMap((row) => row.columns.map((column) => column.elements[0]))
assert.deepEqual(multiChips.map((chip) => chip.behaviors[0].value), [
  { c: 'call-2', q: 0, o: 0 },
  { c: 'call-2', q: 0, o: 1 },
])
const multiAction = multi.body.elements.find(isActionRow)
assert.deepEqual(multiAction.columns.map((column) => column.elements[0].text.content), ['提交', '补充', '跳过'])
// A multi-select question mirrors its ticks in a dedicated, patchable element:
// chip text itself cannot be rewritten, and the note alone hides the choice.
const tickLine = multi.body.elements.find((element) => element.element_id === `${QA_SELECTION_ELEMENT_PREFIX}0`)
assert.ok(tickLine, 'selection mirror element is missing')
assert.match(tickLine.content, /已选：无/)
assert.match(questionSelectionText({ options: [{ label: '甲' }, { label: '乙' }] }, new Set([1])), /已选：乙/)
assert.match(questionSelectionText({ options: [{ label: '甲' }, { label: '乙' }] }, new Set([1, 0])), /甲、乙/)
const freeText = questionCardJson({ callId: 'call-3', questions: [{ id: 'name', question: '叫什么？' }] })
assert.equal(freeText.body.elements.some((element) => element.tag === 'button'), false)

// Element writes only succeed while the card's streaming mode is open.
assert.equal(card.config.streaming_mode, true)

// Eight options stay in the card (no fold): chips wrap into rows of four.
const many = questionCardJson({
  callId: 'call-4',
  questions: [{ id: 'pick', question: '选一个', options: Array.from({ length: 8 }, (_, at) => ({ label: `选项${at + 1}` })) }],
})
const manyChipRows = many.body.elements.filter(isChipRow)
assert.equal(manyChipRows.length, 2)
assert.deepEqual(manyChipRows.map((row) => row.columns.length), [4, 4])
assert.deepEqual(manyChipRows.flatMap((row) => row.columns.map((column) => column.elements[0].behaviors[0].value)), [
  { c: 'call-4', q: 0, o: 0 },
  { c: 'call-4', q: 0, o: 1 },
  { c: 'call-4', q: 0, o: 2 },
  { c: 'call-4', q: 0, o: 3 },
  { c: 'call-4', q: 0, o: 4 },
  { c: 'call-4', q: 0, o: 5 },
  { c: 'call-4', q: 0, o: 6 },
  { c: 'call-4', q: 0, o: 7 },
])
assert.equal(many.body.elements.some((element) => element.tag === 'collapsible_panel'), false)

// Block order inside one question: labels → chips → 说明 → 提交/补充/跳过.
const manyFinePrintIndex = many.body.elements.findIndex((element) => element.text_size === 'notation' && element.element_id === undefined)
const lastChipRowIndex = many.body.elements.map(isChipRow).lastIndexOf(true)
const manyActionIndex = many.body.elements.findIndex(isActionRow)
assert.ok(manyFinePrintIndex > lastChipRowIndex, '说明 must sit below the option chips')
assert.ok(manyActionIndex > manyFinePrintIndex, '提交/补充/跳过 must close the block')

// A stepped card carries the question's batch offset so a click maps back to
// the right question of the batch.
const stepped = questionCardJson({
  callId: 'call-5',
  offset: 1,
  title: '第 2/2 题',
  questions: [{ id: 'second', question: '第二个问题', options: [{ label: '甲' }, { label: '乙' }] }],
})
assert.equal(stepped.header.title.content, '第 2/2 题')
const steppedChips = stepped.body.elements.filter(isChipRow).flatMap((row) => row.columns.map((column) => column.elements[0]))
assert.deepEqual(steppedChips.map((chip) => chip.behaviors[0].value), [
  { c: 'call-5', q: 1, o: 0 },
  { c: 'call-5', q: 1, o: 1 },
])
assert.deepEqual(stepped.body.elements.find(isActionRow).columns.map((column) => column.elements[0].behaviors[0].value), [
  { c: 'call-5', q: 1, other: true },
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

// A free-text channel (WeChat: no buttons) accepts anything as the supplement,
// while a card channel keeps null so an unrelated message starts a new turn.
assert.deepEqual(parseQuestionText('随便聊聊', questions), null)
assert.deepEqual(parseQuestionText('随便聊聊', questions, { allowCustom: true }), [
  { id: 'mode', selected: [], custom: '随便聊聊' },
])
assert.deepEqual(parseQuestionText('2', questions, { allowCustom: true }), [{ id: 'mode', selected: ['纯文本'] }])
assert.deepEqual(parseQuestionText('交互卡片', questions, { allowCustom: true }), [
  { id: 'mode', selected: ['交互卡片（推荐）'] },
])
assert.deepEqual(parseQuestionText('跳过', questions, { allowCustom: true }), [{ id: 'mode', selected: [] }])

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

// 补充: the button only arms the free-text path for that step, and it toggles;
// picking an option afterwards disarms it again so a later message is not eaten.
const otherPending = {
  callId: 'call-other',
  questions: [{ id: 'q', question: 'x', options: [{ label: '甲' }] }],
  selections: [new Set()],
  skipped: new Set(),
  submitted: new Set(),
  otherArmed: new Set(),
}
assert.equal(applyQuestionSelection(otherPending, { c: 'call-other', q: 0, other: true }), true)
assert.equal(otherPending.otherArmed.has(0), true)
assert.equal(isStepSettled(otherPending, 0), false, '补充 alone must not settle the question')
assert.equal(applyQuestionSelection(otherPending, { c: 'call-other', q: 0, other: true }), true)
assert.equal(otherPending.otherArmed.has(0), false, '再点一次「补充」取消')
assert.equal(applyQuestionSelection(otherPending, { c: 'call-other', q: 0, other: true }), true)
assert.equal(applyQuestionSelection(otherPending, { c: 'call-other', q: 0, o: 0 }), true)
assert.equal(otherPending.otherArmed.has(0), false, '选好选项后不再等待补充')
// A recorded supplement rides along as the answer's custom text.
const customPending = {
  callId: 'call-custom',
  questions: [{ id: 'q', question: 'x', options: [{ label: '甲' }] }],
  selections: [new Set()],
  skipped: new Set(),
  submitted: new Set([0]),
  customs: { 0: '都不对，我自己说' },
}
assert.deepEqual(questionAnswersOf(customPending), [{ id: 'q', selected: [], custom: '都不对，我自己说' }])

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
