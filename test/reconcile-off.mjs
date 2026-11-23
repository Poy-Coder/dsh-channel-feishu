/**
 * `reconcile: false` — trust the socket and spend no history-pull quota.
 *
 * The catch-up poll is the only part of this channel that spends base-API calls on a
 * timer, and a free/standard Feishu tenant shares 10,000 a month. The switch exists so
 * that "do we actually need the poll?" can be answered by running without it instead of
 * by argument (issue #6).
 *
 * The end-to-end proof is deliberately not a unit test: it needs a fake long connection
 * and a five-second wait, and it would still only prove the timer. The real proof is the
 * running channel's log — with the switch off, `reconcile` entries stop appearing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { Config, reconcileEnabled } from '../index.js'

test('the schema defaults to on, so an upgrade keeps the safety net', () => {
  assert.equal(Config({}).reconcile, true)
  assert.equal(Config({ reconcile: false }).reconcile, false)
})

test('the predicate treats only an explicit false as off', () => {
  assert.equal(reconcileEnabled({}), true, '没配置 = 开启')
  assert.equal(reconcileEnabled({ reconcile: undefined }), true)
  assert.equal(reconcileEnabled({ reconcile: true }), true)
  assert.equal(reconcileEnabled({ reconcile: false }), false)
  assert.equal(reconcileEnabled(), true, '空配置也要安全默认')
})

test('the status line knows what to say when the poll is off', async () => {
  const { statusText } = await import('../index.js')
  const { registerProvider } = await import('../index.js')
  registerProvider('offline-check', () => ({
    id: 'offline-check',
    label: 'Off',
    settings: () => ({ appId: '', appSecret: '', defaultChatId: 'oc_x', region: 'feishu', baseUrl: '' }),
    settingsAsync: async () => ({ appId: '', appSecret: '', defaultChatId: 'oc_x', region: 'feishu', baseUrl: '' }),
    async sendText() { return { ok: true, messageId: 'om' } },
    parseInbound: () => null,
  }))
  const { apply } = await import('../index.js')
  const ctx = { tools: { register: () => () => {} }, logger: { warn() {} }, get: () => undefined }
  const config = {
    provider: 'offline-check', enabled: true, inboundEnabled: false, sessionId: 'session-x',
    defaultChatId: 'oc_x', reconcile: false,
  }
  apply(ctx, config)
  const text = await statusText(ctx, config, 'oc_x')
  assert.match(text, /补拉：已关闭/)
})
