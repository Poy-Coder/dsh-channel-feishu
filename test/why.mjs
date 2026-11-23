/**
 * The progress placeholder and `/why`.
 *
 * Two channels, two needs. Feishu has a live card, so the card must stay terse —
 * naming the running tool and the clock, with no "type /why" pointer on it (a card
 * that is already updating does not need to teach a command). WeChat has no editable
 * message: it gets one bubble after 30 s and then one per gap, so its first bubble
 * carries the `/why` hint instead (see providers/text-stream.js).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { progressText, whyText } from '../index.js'

const record = (over = {}) => ({ startedAt: Date.now() - 42_000, phase: 'thinking', toolSteps: 0, activity: '', ...over })

test('the card progress line never advertises /why', () => {
  const text = progressText(record({ startedAt: Date.now() - 30_000 }))
  assert.match(text, /思考中/)
  assert.match(text, /已用时 30s/)
  assert.doesNotMatch(text, /\/why/, 'a live card does not need the hint; WeChat adds it')
})

test('with a tool running the card names it', () => {
  const text = progressText(record({ activity: 'read_file', toolSteps: 2 }))
  assert.match(text, /正在执行 read_file/)
  assert.match(text, /已调用 2 个工具/)
  assert.doesNotMatch(text, /\/why/)
})

test('when no turn runs, why says so without inventing details', () => {
  const text = whyText({}, 'session-none')
  assert.match(text, /没有正在跑的回合/)
  assert.match(text, /正常/)
  assert.equal(text.split('\n').length, 1, 'why must stay a single line')
})

test('an early turn omits the clock so the card does not tick from zero', () => {
  const text = progressText(record({ startedAt: Date.now() - 1_000 }))
  assert.doesNotMatch(text, /已用时/)
  assert.match(text, /思考中/)
})
