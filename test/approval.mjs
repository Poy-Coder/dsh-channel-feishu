/**
 * Hermetic checks for the approval bridge's reply parsing.
 *
 * The bridge itself needs a live chat, but the part that decides what counts as
 * consent is a pure function and is where a mistake would be dangerous: a loose
 * match would read "1" out of an ordinary message as permission.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { approvalCardJson, parseApprovalAnswer } from '../index.js'

test('a clear yes grants exactly one call', () => {
  for (const text of ['1', 'y', 'yes', 'ok', 'OK', '允许', '同意', '可以', '好', '批准', '行']) {
    assert.equal(parseApprovalAnswer(text), 'allow', `${text} should allow`)
  }
  assert.equal(parseApprovalAnswer('  1  '), 'allow')
})

test('a clear no refuses', () => {
  for (const text of ['2', 'n', 'no', '拒绝', '不行', '不允许', '否', '取消', '别']) {
    assert.equal(parseApprovalAnswer(text), 'deny', `${text} should deny`)
  }
})

test('anything else is a message to the agent, not consent', () => {
  for (const text of ['', '   ', '1 还是不要了吧', '为什么需要这个权限？', 'Y 什么', '2号文件在哪', 'allow']) {
    assert.equal(parseApprovalAnswer(text), undefined, `${JSON.stringify(text)} must not settle the approval`)
  }
})

test('silence is never consent', () => {
  // 空回复不应该被解析成允许——超时路径单独按拒绝处理
  assert.equal(parseApprovalAnswer(undefined), undefined)
  assert.equal(parseApprovalAnswer(null), undefined)
})

// ---------------------------------------------------------------------------
// The card is what Feishu users actually see; its shape is a contract.
// ---------------------------------------------------------------------------

const buttonsOf = (card) => card.body.elements
  .flatMap((element) => (element.tag === 'column_set' ? element.columns.flatMap((column) => column.elements) : [element]))
  .filter((element) => element.tag === 'button')

test('the pending card offers exactly allow and deny', () => {
  const card = approvalCardJson({ toolName: 'pwsh', reason: '写入工作区以外的路径' })
  const buttons = buttonsOf(card)
  assert.equal(buttons.length, 2)
  assert.deepEqual(buttons.map((button) => button.behaviors[0].value), [{ a: 'allow' }, { a: 'deny' }])
  assert.equal(buttons[0].type, 'primary')
  assert.equal(buttons[1].type, 'danger')
  assert.equal(card.header.template, 'orange')
  // 工具与原因都要出现在卡片正文里，用户才知道在批准什么
  const text = JSON.stringify(card.body)
  assert.match(text, /pwsh/)
  assert.match(text, /写入工作区以外的路径/)
})

test('the settled card keeps no buttons and states the outcome', () => {
  const allowed = approvalCardJson({ toolName: 'pwsh', decision: 'allow' })
  assert.equal(buttonsOf(allowed).length, 0)
  assert.equal(allowed.header.template, 'green')
  assert.match(JSON.stringify(allowed.body), /已允许这一次/)

  const denied = approvalCardJson({ toolName: 'pwsh', decision: 'deny' })
  assert.equal(buttonsOf(denied).length, 0)
  assert.equal(denied.header.template, 'red')
  assert.match(JSON.stringify(denied.body), /已拒绝/)
})

test('the status line is patchable and streaming stays open', () => {
  const card = approvalCardJson({ toolName: 'pwsh' })
  const status = card.body.elements.find((element) => element.element_id === 'approval_status')
  assert.ok(status, 'the decision patch needs a stable element id')
  assert.equal(card.config.streaming_mode, true, '300309 without streaming_mode')
  assert.equal(card.schema, '2.0')
})
