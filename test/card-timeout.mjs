/**
 * A streaming card dies while the turn is still running.
 *
 * Feishu closes a streaming card after roughly ten to twenty minutes. A long turn must
 * notice that, build a new card, and keep printing — otherwise the chat freezes on a
 * stale "思考中…" and the final answer never appears.
 *
 * The failure that made this test necessary (2026-11-24): a 19-minute turn hit
 * `200850 card streaming timeout`, which the recovery branch did not recognise, so the
 * turn marked the card as failed and never recovered. `200850` and `300309` are the same
 * event from two sides and both must land in the recovery path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const SOURCE = await import('node:fs').then(({ readFileSync }) =>
  readFileSync(new URL('../index.js', import.meta.url), 'utf8'))

test('both timeout codes are classified as a closed streaming card', () => {
  const match = /const isStreamingClosed = \(error\) => (.+)/.exec(SOURCE)
  assert.ok(match, '找不到 isStreamingClosed 定义')
  const pattern = match[1]
  assert.match(pattern, /300309/, '300309 streaming mode is closed')
  assert.match(pattern, /200850/, '200850 card streaming timeout — 缺了它整条恢复路径失效')
})

test('recovering clears cardFailed, or the replacement can never be built', () => {
  const block = /isStreamingClosed\(error\) && \(record\.recreations[^]*?scheduleCardFlush\(record, ctx, config\)/.exec(SOURCE)
  assert.ok(block, '找不到恢复分支')
  assert.match(block[0], /record\.cardFailed = false/, 'ensureCard 会因为 cardFailed 拒绝建新卡')
})

test('the recreation budget covers a long turn', () => {
  const budget = /\(record\.recreations \?\? 0\) < (\d+)\)/.exec(SOURCE)
  assert.ok(budget, '找不到重建次数上限')
  const limit = Number(budget[1])
  assert.ok(limit >= 6, `当前上限 ${limit}，养一个两小时的任务会中途断卡`)
})
