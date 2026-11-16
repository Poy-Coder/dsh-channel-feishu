/**
 * Hermetic regression test for a reconnect replaying answered messages.
 *
 * Live events carry an event id (`evt-…`) but the catch-up pull that runs after
 * a reconnect rebuilds history from `im/v1/messages`, which has no event id —
 * the provider labels those `catchup:<message_id>`. Remembering only the live
 * key meant the two identities never matched, so every restart or reconnect
 * re-delivered the last ten minutes of already answered messages and the bot
 * answered them again.
 *
 * Usage: node test/dedupe.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'feishu-dedupe-'))
process.env.DSH_HOME = home
const logFile = join(home, 'dedupe-inbound.log')

const { apply, handleInboundEvent, registerProvider } = await import('../index.js')
const { parseInboundEvent } = await import('../providers/feishu.js')

registerProvider('dedupe', () => ({
  id: 'dedupe',
  label: 'Dedupe',
  settings: () => ({ appId: '', appSecret: '', defaultChatId: 'oc_dedupe', region: 'feishu', baseUrl: '' }),
  settingsAsync: async () => ({ appId: '', appSecret: '', defaultChatId: 'oc_dedupe', region: 'feishu', baseUrl: '' }),
  async sendText() { return { ok: true, messageId: 'om_text' } },
  async removeReaction() {},
  parseInbound: parseInboundEvent,
}))

const ctx = { tools: { register: () => () => {} }, logger: { warn() {} }, get: () => undefined }
const config = {
  provider: 'dedupe',
  enabled: true,
  inboundEnabled: false,
  sessionId: 'session-dedupe',
  defaultChatId: 'oc_dedupe',
  logFile,
}
apply(ctx, config)

/** A `sender_type: app` message settles without touching a session. */
const message = (id, senderType = 'app') => ({
  message: {
    message_id: id, chat_id: 'oc_dedupe', chat_type: 'p2p', message_type: 'text',
    content: JSON.stringify({ text: 'hello' }),
  },
  sender: { sender_id: { open_id: 'ou_1' }, sender_type: senderType },
})

const seen = new Set()

// Live delivery first, then the post-reconnect catch-up of the same message.
await handleInboundEvent(ctx, config, { header: { event_id: 'evt-live-1' }, ...message('om_1') }, seen)
assert.ok(seen.has('evt-live-1'), 'the live event id was not remembered')
assert.ok(seen.has('om_1'), 'the message id was not remembered')

await handleInboundEvent(ctx, config, { header: { event_id: 'catchup:om_1' }, ...message('om_1') }, seen)
assert.equal(seen.has('catchup:om_1'), false, 'the replayed catch-up event was treated as new')

// The other order: catch-up wins the race, the live event arrives afterwards.
await handleInboundEvent(ctx, config, { header: { event_id: 'catchup:om_2' }, ...message('om_2') }, seen)
await handleInboundEvent(ctx, config, { header: { event_id: 'evt-live-2' }, ...message('om_2') }, seen)
assert.equal(seen.has('evt-live-2'), false, 'the late live event was treated as new')

const logs = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const hits = logs.filter((line) => line.event === 'inbound' && line.result === 'dedupe-hit')
assert.equal(hits.length, 2, `expected two dedupe hits, saw ${hits.length}: ${JSON.stringify(hits)}`)
assert.deepEqual(hits.map((line) => line.messageId).sort(), ['om_1', 'om_2'])

// The remembered keys survive a restart through the channel state file.
const state = JSON.parse(readFileSync(join(home, 'dedupe-channel-state.json'), 'utf8'))
for (const key of ['evt-live-1', 'om_1', 'catchup:om_2', 'om_2']) {
  assert.ok(state.seenEvents.includes(key), `seenEvents lost ${key}`)
}

console.log('dedupe: all assertions passed')
