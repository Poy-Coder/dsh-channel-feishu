/**
 * Hermetic regression test for the "two cards per answer" bug.
 *
 * Feishu numbers writes per card entity (`sequence`) and rejects one that is not
 * greater than the last it applied: `300317 sequence number compare failed`.
 * The 200 ms flush timer and `finalizeTurn` both write to the same entity, so a
 * late flush used to race the close; the close lost, the turn fell into
 * `close-failed` and re-posted the answer as a second card.
 *
 * The fake server below applies a write only when the simulated network delivers
 * it (updates can be slow, closes are slow by default), which is exactly the
 * interleaving that broke production. Usage: node test/card-race.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'feishu-card-race-'))
process.env.DSH_HOME = home
const logFile = join(home, 'race-inbound.log')

const { apply, observeAssistantStream, observeSessionEvent, registerProvider } = await import('../index.js')

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const server = { cards: 0, seqs: new Map(), writes: [], closed: new Set() }

/** A write reaches Feishu only when the network delivers it; arrival is ranked. */
function deliver(cardId, sequence, kind) {
  const last = server.seqs.get(cardId) ?? 0
  if (sequence <= last) {
    throw new Error('Feishu API error 300317: ErrMsg: sequence number compare failed; ')
  }
  server.seqs.set(cardId, sequence)
  server.writes.push({ cardId, sequence, kind })
  if (kind === 'close') server.closed.add(cardId)
}

// How slow each kind of write is on the wire. One slow update is enough: the
// flush that is still in flight when the turn ends gets delivered after
// `finalizeTurn` has already numbered its own writes.
let slowUpdates = 1
const latency = (kind) => {
  if (kind === 'close') return 400
  if (slowUpdates > 0) { slowUpdates -= 1; return 300 }
  return 0
}

registerProvider('race', () => ({
  id: 'race',
  label: 'Race',
  settings: () => ({ appId: '', appSecret: '', defaultChatId: 'oc_race', region: 'feishu', baseUrl: '' }),
  settingsAsync: async () => ({ appId: '', appSecret: '', defaultChatId: 'oc_race', region: 'feishu', baseUrl: '' }),
  async sendText() { return { ok: true, messageId: 'om_text' } },
  async removeReaction() {},
  parseInbound: () => null,
  card: {
    async create() { server.cards += 1; return `card_${server.cards}` },
    async attach() { return 'om_card' },
    async update({ cardId, sequence }) { await sleep(latency('update')); deliver(cardId, sequence, 'update') },
    async close({ cardId, sequence }) { await sleep(latency('close')); deliver(cardId, sequence, 'close') },
  },
}))

const ctx = {
  tools: { register: () => () => {} },
  logger: { warn() {} },
  get: () => undefined,
}
const config = {
  provider: 'race',
  enabled: true,
  inboundEnabled: false,
  thinking: false,
  sessionId: 'session-race',
  defaultChatId: 'oc_race',
  logFile,
  streamingCards: true,
  reactions: false,
}
apply(ctx, config)

const session = { id: 'session-race' }
const cardEvents = () => readFileSync(logFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((line) => line.event === 'card')
  .map((line) => line.result)

// Turn 1 — a streamed answer. The 200 ms flush is still on the wire when the
// turn ends, so `finalizeTurn` writes the last text and closes while it lands.
observeSessionEvent(ctx, config, session, { type: 'turn/start', data: { turn: 1 } })
await sleep(20)
for (const piece of ['卡片', '只能', '有一张。']) {
  observeAssistantStream(ctx, config, {
    frame: { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: piece } },
  }, 'session-race', 1)
}
await sleep(230)
observeSessionEvent(ctx, config, session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'ok' } } })
await sleep(1_600)

// Turn 2 — the engine hands over the whole answer in one burst. No flush fires
// before `turn/end`, so the finalize path replays it slice by slice.
const longText = ('这是一段比较长的回答，用来验证一次性交付整段文字时收尾阶段仍然按切片回放，'
  + '并且不会和流式写入抢占同一个 sequence。').repeat(2)
observeSessionEvent(ctx, config, session, { type: 'turn/start', data: { turn: 2 } })
await sleep(10)
observeSessionEvent(ctx, config, session, {
  type: 'assistant/message',
  data: { turn: 2, message: { content: [{ type: 'text', text: longText }] } },
})
observeSessionEvent(ctx, config, session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'ok' } } })
await sleep(5_000)

const results = cardEvents()
assert.equal(server.cards, 2, `expected one card per turn, created ${server.cards}`)
assert.deepEqual([...server.closed].sort(), ['card_1', 'card_2'], 'a turn card never got closed')
assert.equal(results.filter((result) => result === 'closed').length, 2, `card events: ${results.join(',')}`)
assert.ok(!results.includes('reposted'), 'an answer was re-posted as a second card')
assert.ok(!results.includes('close-failed'), 'a close failed instead of retrying the sequence conflict')
// The burst path really ran: the long answer went out in slices, not one jump.
assert.ok(server.writes.filter((write) => write.cardId === 'card_2' && write.kind === 'update').length > 10,
  'the burst replay did not slice the answer')
// Writes reached Feishu in the order they were numbered, per card.
for (const cardId of ['card_1', 'card_2']) {
  const seqs = server.writes.filter((write) => write.cardId === cardId).map((write) => write.sequence)
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], `${cardId}: card writes arrived out of order`)
  }
}

console.log('card-race: all assertions passed')
