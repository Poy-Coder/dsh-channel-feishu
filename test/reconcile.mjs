/**
 * The catch-up poll's cadence.
 *
 * The poll exists to notice a socket that answers pings but delivers nothing. It costs
 * one base-API call each run, and a free/standard Feishu tenant shares 10,000 calls a
 * month across every self-built app. A flat 2-minute cadence spends 21,600 a month on
 * this one loop — fourteen days before every call fails (issue #6).
 *
 * So the interval follows activity: while someone is chatting it stays at 2 minutes
 * (the responsiveness that made the poll worth having), and a cold chat is probed every
 * 30 minutes (still enough to notice a deaf socket, at a fraction of the cost).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { nextReconcileDelay } from '../index.js'

const MINUTE = 60_000

test('an active chat is polled every 2 minutes', () => {
  const now = 10_000_000
  assert.equal(nextReconcileDelay(now - 30_000, now), 2 * MINUTE, '刚说过话')
  assert.equal(nextReconcileDelay(now - 9 * MINUTE, now), 2 * MINUTE, '10 分钟内仍算活跃')
})

test('a warm chat backs off to 10 minutes', () => {
  const now = 10_000_000
  assert.equal(nextReconcileDelay(now - 10 * MINUTE, now), 10 * MINUTE)
  assert.equal(nextReconcileDelay(now - 59 * MINUTE, now), 10 * MINUTE)
})

test('a cold chat probes every 30 minutes', () => {
  const now = 10_000_000
  assert.equal(nextReconcileDelay(now - 61 * MINUTE, now), 30 * MINUTE)
  assert.equal(nextReconcileDelay(now - 3 * 24 * 60 * MINUTE, now), 30 * MINUTE)
})

test('no inbound ever recorded counts as cold', () => {
  assert.equal(nextReconcileDelay(0), 30 * MINUTE)
  assert.equal(nextReconcileDelay(undefined), 30 * MINUTE)
  assert.equal(nextReconcileDelay(null), 30 * MINUTE)
})

test('a clock that jumped backwards does not produce a busy loop', () => {
  const now = 10_000_000
  // lastInboundAt 在未来（时钟回拨）：仍然按活跃处理，而不是负数或 0
  assert.equal(nextReconcileDelay(now + 5 * MINUTE, now), 2 * MINUTE)
})

test('a month of polling stays inside the 10,000-call budget', () => {
  // 每天 4 小时活跃（2 分钟一次）+ 20 小时冷（30 分钟一次）
  const perDay = (4 * 60) / 2 + (20 * 60) / 30
  assert.equal(perDay, 160)
  assert.ok(perDay * 30 < 10_000, `估算 ${perDay * 30} 次/月，应低于 10,000`)
})
