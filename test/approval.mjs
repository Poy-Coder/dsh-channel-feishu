/**
 * Hermetic checks for the approval bridge's reply parsing.
 *
 * The bridge itself needs a live chat, but the part that decides what counts as
 * consent is a pure function and is where a mistake would be dangerous: a loose
 * match would read "1" out of an ordinary message as permission.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseApprovalAnswer } from '../index.js'

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
