/**
 * DSH channel framework (host half) — Feishu today, any IM by adding a provider.
 *
 * Transport (WebSocket/HTTP, uploads, card primitives, message parsing) lives in
 * `providers/<id>.js`; this file owns channel behavior:
 *
 *   - tools: feishu_send_message / feishu_send_file / feishu_channel_status
 *   - inbound: provider event → verbatim user message in one DSH session
 *   - outbound: the turn's answer streams into a card and closes on `turn/end`
 *   - sessions: target resolution, `/new`, workspace attach, naming, permissions
 *
 * Adding another IM: implement the contract documented in `providers/feishu.js`,
 * register the factory in `providers/registry.js`, then set `provider: '<id>'`.
 *
 * Settings precedence (per provider), highest first:
 *   1. the row `config` in cordis.patch.yml (non-empty fields only)
 *   2. the environment (FEISHU_APP_ID / FEISHU_APP_SECRET)
 *   3. the credentials file <DSH_HOME>/feishu-channel.json
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'

import { resolveProvider, providerIds } from './providers/registry.js'
import { credentialsFilePath } from './providers/feishu.js'

// Transport helpers stay importable from the package entry so tests and other
// callers did not have to move when the adapter was split out.
export {
  attachmentKind,
  closeCard,
  createCard,
  downloadMessageImage,
  imageExtension,
  inboundFilesDir,
  parseImageContent,
  parseInboundEvent,
  parsePostContent,
  parseTextContent,
  resolveSettings,
  sendAttachment,
  sendCard,
  sendTextMessage,
  stripMentions,
  tenantToken,
  updateCardText,
} from './providers/feishu.js'

export { providerIds, registerProvider, resolveProvider } from './providers/registry.js'

export const name = 'feishu-channel'
export const inject = ['tools']

/**
 * Row configuration schema: Settings renders these fields and rejects a bad
 * value before the plugin activates. Provider-specific knobs (appId/appSecret/
 * region/defaultChatId) stay optional here because the credentials store and
 * `~/.dsh/feishu-channel.json` remain valid sources.
 */
export const Config = z.object({
  provider: z.string().default('feishu').description('Transport adapter id (see providers/registry.js).'),
  enabled: z.boolean().default(true).description('Register the channel tools at all.'),
  inboundEnabled: z.boolean().default(false).description('Open the long connection and accept messages from the IM.'),
  sessionId: z.string().default('').description('DSH session inbound messages are delivered to.'),
  sessionMode: z.union([z.const('resume'), z.const('create'), z.const('off')]).default('resume')
    .description('resume reuses the stored session; create makes one when it is missing; off never activates one.'),
  allowedUsers: z.array(z.string()).default([]).description('Sender ids allowed to drive this channel; empty means anyone.'),
  workspacePath: z.string().default('').description('Workspace directory that owns this channel\u2019s sessions.'),
  cwd: z.string().default('').description('Working directory for sessions this channel creates.'),
  preset: z.string().default('').description('Agent preset to mount for resumed/created sessions.'),
  idleReleaseMinutes: z.number().default(30).description('Minutes of quiet before the plugin hands its agent back; 0 keeps it alive.'),
  notifyOnNew: z.boolean().default(true).description('Reply on the IM when /new creates a session.'),
  streamingCards: z.boolean().default(true).description('Stream answers into a card; off sends plain text.'),
  autoReply: z.boolean().default(true).description('Deliver each turn\u2019s answer back to the originating chat.'),
  thinking: z.boolean().default(true).description('Show the native thinking process (reasoning and tool calls) during a turn.'),
  thinkingHidden: z.boolean().default(false).description('Hide the thinking process once the turn finishes.'),
  reactions: z.boolean().default(true).description('Acknowledge an inbound message with a reaction while the turn runs.'),
  permissionPreset: z.string().default('danger-full-access').description('Permission preset applied to sessions in this channel\u2019s workspace.'),
  applyPermissionPreset: z.boolean().default(true).description('Turn the permission preset switch off.'),
  region: z.union([z.const('feishu'), z.const('lark')]).default('feishu').description('Feishu China or Lark international.'),
  appId: z.string().default('').description('Optional app id; prefer the credentials store or credentials file.'),
  appSecret: z.string().default('').description('Optional app secret; prefer the credentials store or credentials file.'),
  defaultChatId: z.string().default('').description('Destination used when a tool call omits receiveId.'),
  logFile: z.string().default('').description('Inbound diagnostics log path.'),
  stateFile: z.string().default('').description('Channel state path (current session, chat memory).'),
  inboundFilesDir: z.string().default('').description('Where inbound images are saved.'),
})

/** The provider the running channel speaks through; set once in `apply`. */
let activeProvider

function provider() {
  if (!activeProvider) throw new Error('channel provider is not initialized')
  return activeProvider
}

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

/**
 * Collect every configuration problem before touching the network, so one call
 * reports credentials and destination together instead of one at a time.
 */
function requireReadiness(settings, args) {
  const problems = []
  if (!settings.appId || !settings.appSecret) {
    problems.push(
      'missing appId/appSecret (row config, FEISHU_APP_ID / FEISHU_APP_SECRET, '
      + `or ${credentialsFilePath()})`,
    )
  }
  let target
  try {
    target = destination(settings, args)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  if (problems.length > 0) throw new Error(`channel not ready: ${problems.join('; ')}`)
  return target
}

function destination(settings, args) {
  const receiveId = firstNonEmpty(args.receiveId, settings.defaultChatId)
  if (!receiveId) {
    throw new Error(
      'No destination: pass receiveId in the tool call, set defaultChatId in the row config, '
      + 'or add defaultChatId to the credentials file.',
    )
  }
  const declared = String(args.receiveIdType ?? '').trim()
  const receiveIdType = declared || (receiveId.startsWith('oc_') ? 'chat_id' : 'open_id')
  return { receiveId, receiveIdType }
}

// ---------------------------------------------------------------------------
// Outbound delivery
//
// The channel is a transport, not a prompt convention: an inbound message is
// forwarded exactly as the human typed it, and the answer travels back through
// this section instead of through a "reply to chat X with tool Y" instruction
// that would otherwise sit in the conversation log forever.
//
//   - chat memory: which Feishu chat each DSH session came from
//   - streaming card: one CardKit entity per turn, fed cumulative text
//   - finalize: `turn/end` closes the card (or falls back to a text message)
// ---------------------------------------------------------------------------

const CARD_FLUSH_MS = 200
const MAX_CARD_UPDATES = 240
const MAX_REPLY_CHARS = 15_000
const CHAT_MEMORY = new Map()
const turns = new Map()

// `agent/assistant-stream` is published on the agent's own context, so a
// plugin-level listener never receives it; subscribe once per agent.
const streamWatchers = new Map()
/** Last turn seen in a `start` frame — `chunk` and `end` frames do not carry one. */
const streamTurn = new Map()
let streamFrames = 0
const streamChunks = { text: 0, reasoning: 0, other: 0 }
let flushScheduled = 0
let flushRan = 0
const observeStats = { mismatch: 0, noFrame: 0, start: 0, end: 0, chunk: 0 }
let lastObserve = ''
let lastStreamShape = ''
let channelRuntime

const describeShape = (value) => {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return typeof value
  const keys = Object.keys(value).slice(0, 12)
  const parts = keys.map((key) => {
    const inner = value[key]
    if (inner === null || inner === undefined) return `${key}:${String(inner)}`
    return `${key}:${typeof inner === 'object' ? 'obj' : typeof inner}`
  })
  return `{${parts.join(',')}}`
}

/** Counters for `/status` and the diagnostics log. */
export function streamStats() {
  return {
    frames: streamFrames,
    watchers: streamWatchers.size,
    textChunks: streamChunks.text,
    reasoningChunks: streamChunks.reasoning,
    otherChunks: streamChunks.other,
    flushScheduled,
    flushRan,
    mismatch: observeStats.mismatch,
    noFrame: observeStats.noFrame,
    start: observeStats.start,
    end: observeStats.end,
    chunk: observeStats.chunk,
  }
}

/** Subscribe the channel to one agent's live token stream (idempotent). */
export function watchAgentStreams(agent, runtime = channelRuntime) {
  const session = agent?.session
  const id = session?.id ?? agent?.id
  if (!id || streamWatchers.has(id)) return false
  if (typeof agent?.ctx?.on !== 'function') return false
  // Only the channel's own sessions matter: the target session, or any session
  // living in the channel's workspace.
  const config = runtime?.config ?? {}
  const target = String(config.sessionId ?? '').trim() || (runtime ? currentSessionId(config) : '')
  const workspace = runtime ? normalizePath(workspacePathFor(config)) : ''
  const relevant = (target && id === target) || (workspace && normalizePath(session?.header?.cwd) === workspace)
  if (!relevant) return false
  try {
    const off = agent.ctx.on('agent/assistant-stream', (payload) => {
      streamFrames += 1
      if (streamFrames === 1) {
        lastStreamShape = `payload=${describeShape(payload)} frame=${describeShape(payload?.frame)}`
        logInbound(runtime?.config ?? {}, { event: 'debug', result: 'stream-shape', shape: lastStreamShape })
      }
      // `start` carries turn/step; `chunk` and `end` do not, so remember it.
      const frame = payload?.frame
      if (frame?.type === 'start' && Number.isFinite(frame.turn)) streamTurn.set(id, frame.turn)
      const turn = Number.isFinite(frame?.turn) ? frame.turn : streamTurn.get(id)
      // DSH emits `{ frame, agent }`; the session id comes from this
      // subscription, so a payload without `agent` still resolves.
      if (runtime) observeAssistantStream(runtime.ctx, runtime.config, payload, id, turn)
    })
    streamWatchers.set(id, off)
    return true
  } catch {
    return false
  }
}

function disposeAgentStreams() {
  for (const off of streamWatchers.values()) {
    try { off?.() } catch { /* ignore */ }
  }
  streamWatchers.clear()
  streamTurn.clear()
}


function replyTargetOf(config, sessionId) {
  return CHAT_MEMORY.get(sessionId) || provider().settings().defaultChatId
}

/** Remember where a session came from, in memory and in the channel state file. */
function rememberChat(config, sessionId, { chatId, senderId }) {
  if (!sessionId || !chatId) return
  CHAT_MEMORY.set(sessionId, chatId)
  if (CHAT_MEMORY.size > 64) CHAT_MEMORY.delete(CHAT_MEMORY.keys().next().value)
  try {
    const state = readChannelState(config)
    const chats = { ...(state.chats ?? {}), [sessionId]: { chatId, senderId: String(senderId ?? ''), at: Date.now() } }
    writeChannelState(config, { chats })
  } catch {
    // Chat memory is a convenience; never let it block delivery.
  }
}

/** Restore the persisted session→chat map (survives restarts). */
function loadChatMemory(config) {
  let state = {}
  try { state = readChannelState(config) } catch { state = {} }
  for (const [sessionId, info] of Object.entries(state.chats ?? {})) {
    const chatId = String(info?.chatId ?? '').trim()
    if (sessionId && chatId) CHAT_MEMORY.set(sessionId, chatId)
  }
}

/** Session events arrive hot; the state file is read at most once a second. */
let activeCache = { key: '', value: '', at: 0 }
function activeSessionId(config) {
  const key = String(config?.sessionId ?? '')
  const now = Date.now()
  if (activeCache.key === key && now - activeCache.at < 1_000) return activeCache.value
  activeCache = { key, value: currentSessionId(config), at: now }
  return activeCache.value
}
function invalidateActiveSession() {
  activeCache = { key: '', value: '', at: 0 }
}

function turnRecord(sessionId, turn) {
  const key = `${sessionId}|${turn}`
  let record = turns.get(key)
  if (record) return record
  record = {
    key, sessionId, turn,
    committed: '', stepStream: '', stepBlocks: new Set(),
    card: undefined, cardFailed: false, sentByTool: false, lastCardText: '', updates: 0,
    backoffUntil: 0, cardCreating: undefined, timer: undefined, lastSentAt: 0, phase: 'thinking',
  }
  turns.set(key, record)
  if (turns.size > 64) {
    const oldest = turns.keys().next().value
    if (oldest !== key) turns.delete(oldest)
  }
  return record
}

function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** Shown from turn start until the first answer token arrives. */
const THINKING_TEXT = '思考中…'

/** The text a card/text reply should carry right now: committed steps + live deltas. */
function replyText(record) {
  const head = String(record.committed ?? '').trimEnd()
  const tail = String(record.stepStream ?? '')
  const joined = [head, tail].filter(Boolean).join(head && tail ? '\n\n' : '')
  if (!joined) return record.phase === 'answering' ? '' : THINKING_TEXT
  if (joined.length <= MAX_REPLY_CHARS) return joined
  return `${joined.slice(0, MAX_REPLY_CHARS)}\n\n…（内容过长，已截断）`
}

function summaryOf(text) {
  const line = String(text ?? '').split('\n').map((value) => value.trim()).find(Boolean) ?? 'DSH'
  return line.length > 40 ? `${line.slice(0, 40)}…` : line
}

/**
 * Create the turn's card exactly once, even when several flushes race: without
 * the single-flight guard two in-flight flushes each created a card, the chat
 * rate limit kicked in (230020), and the reply fell back to text as well.
 */
async function ensureCard(record, ctx, config) {
  if (record.card) return record.card
  if (record.cardFailed) return undefined
  if (record.cardCreating) return await record.cardCreating
  const chatId = replyTargetOf(config, record.sessionId)
  if (!chatId) return undefined
  const text = replyText(record)
  record.cardCreating = (async () => {
    const attempt = async () => {
      const cardId = await provider().card.create({ text, summary: summaryOf(text) })
      const messageId = await provider().card.attach({ chatId, cardId })
      return { cardId, messageId }
    }
    try {
      let created
      try {
        created = await attempt()
      } catch (error) {
        if (!isRateLimited(error)) throw error
        // Chat-level limits are transient: wait once and retry before giving up.
        await new Promise((resolve) => { const t = setTimeout(resolve, 1_500); t.unref?.() })
        created = await attempt()
      }
      record.card = { cardId: created.cardId, messageId: created.messageId, sequence: 1 }
      record.lastCardText = text
      record.lastSentAt = Date.now()
      logInbound(config, {
        event: 'card', result: 'created', sessionId: record.sessionId, turn: record.turn,
        cardId: created.cardId, messageId: created.messageId, chatId,
      })
      return record.card
    } catch (error) {
      record.cardFailed = true
      warnTo(ctx, `streaming card failed, will fall back to text: ${errorText(error)}`)
      logInbound(config, {
        event: 'card', result: 'create-failed', sessionId: record.sessionId, turn: record.turn, reason: errorText(error),
      })
      return undefined
    } finally {
      record.cardCreating = undefined
    }
  })()
  return await record.cardCreating
}

/** Coalesce stream deltas: one Feishu write per CARD_FLUSH_MS at most. */
function scheduleCardFlush(record, ctx, config) {
  if (record.timer) return
  // Feishu documents ~8 card writes/second; 200 ms keeps us well under it, and a
  // rate-limit answer pushes the next write out by the backoff instead of
  // spamming.
  if (record.updates >= MAX_CARD_UPDATES) return
  flushScheduled += 1
  const delay = Math.max(
    0,
    CARD_FLUSH_MS - (Date.now() - record.lastSentAt),
    (record.backoffUntil ?? 0) - Date.now(),
  )
  record.timer = setTimeout(() => {
    record.timer = undefined
    void flushCard(record, ctx, config)
  }, delay)
  record.timer.unref?.()
}

const isRateLimited = (error) => /230020|frequency limit|rate limit/i.test(String(error?.message ?? error))

async function flushCard(record, ctx, config) {
  flushRan += 1
  const text = replyText(record)
  if (!text.trim()) return
  // One write in flight per card: a second PATCH started before the first
  // returns would reuse the sequence number and Feishu rejects the batch.
  if (record.flushing) {
    record.flushPending = true
    return
  }
  const card = await ensureCard(record, ctx, config)
  if (!card) return
  if (text === record.lastCardText) return
  record.flushing = true
  try {
    card.sequence += 1
    await provider().card.update({ cardId: card.cardId, content: text, sequence: card.sequence })
    record.lastCardText = text
    record.updates = (record.updates ?? 0) + 1
    record.lastSentAt = Date.now()
  } catch (error) {
    if (isRateLimited(error)) {
      // Keep the card: slow down instead of dropping to text, which would need
      // another message and hit the same limit.
      record.backoffUntil = Date.now() + 2_000
      logInbound(config, {
        event: 'card', result: 'rate-limited', sessionId: record.sessionId, turn: record.turn, sequence: card.sequence,
      })
    } else {
      record.cardFailed = true
      warnTo(ctx, `card text update failed, will fall back to text: ${errorText(error)}`)
      logInbound(config, {
        event: 'card', result: 'update-failed', sessionId: record.sessionId, turn: record.turn, reason: errorText(error),
      })
    }
  } finally {
    record.flushing = false
    if (record.flushPending) {
      record.flushPending = false
      scheduleCardFlush(record, ctx, config)
    }
  }
}

/**
 * Close one turn: finish the card that already carries the answer, or send the
 * answer as a plain text message when cards are off or unavailable.
 */
export async function finalizeTurn(ctx, config, sessionId, turn, reason) {
  const key = `${sessionId}|${turn}`
  const record = turns.get(key)
  if (!record) return
  turns.delete(key)
  if (record.timer) {
    clearTimeout(record.timer)
    record.timer = undefined
  }
  // Drop the acknowledgement reaction now that the turn is over.
  const ack = ackReactions.get(sessionId)
  if (ack) {
    ackReactions.delete(sessionId)
    void provider().removeReaction(ack).catch(() => {})
  }
  const text = replyText(record).trim()
  const chatId = replyTargetOf(config, sessionId)
  const cardsOn = config.streamingCards !== false

  // Nothing but the placeholder: finish the card with a clear note instead of
  // leaving a "thinking" card open forever.
  if (!text || text === THINKING_TEXT) {
    if (cardsOn && record.card) {
      const note = reason?.kind === 'error' ? '（这一轮出错了，没有产生回复）' : '（没有产生文字回答）'
      try {
        record.card.sequence += 1
        await provider().card.update({
          cardId: record.card.cardId, content: note, sequence: record.card.sequence,
        })
        record.card.sequence += 1
        await provider().card.close({
          cardId: record.card.cardId, sequence: record.card.sequence, summary: note,
        })
        logInbound(config, {
          event: 'card', result: 'closed', sessionId, turn, cardId: record.card.cardId,
          chars: 0, updates: record.updates ?? 0, note: 'empty',
        })
        return
      } catch (error) {
        warnTo(ctx, `card close (empty) failed: ${errorText(error)}`)
      }
    }
    if (reason?.kind === 'error' && chatId) {
      try {
        await sendChannelText(config, chatId, '这一轮处理出错了，没有产生回复。')
      } catch { /* best effort */ }
    }
    return
  }

  if (cardsOn) {
    const card = await ensureCard(record, ctx, config)
    if (card) {
      try {
        // The engine can hand over the whole answer in one burst, which would
        // land as a single jump. When that happens, replay the text in slices so
        // the reader still sees it appear progressively.
        const shown = String(record.lastCardText ?? '').length
        const burst = (record.updates ?? 0) < 8 && text.length > 80 && shown < text.length
        if (burst) {
          // ~10 characters per tick, 150 ms apart, with the network round trip
          // subtracted so the cadence does not stretch to RTT + sleep.
          const tick = 150
          const size = Math.max(6, Math.ceil(text.length / 40))
          for (let end = Math.min(shown + size, text.length); end < text.length; end += size) {
            const started = Date.now()
            card.sequence += 1
            await provider().card.update({
              cardId: card.cardId, content: text.slice(0, end), sequence: card.sequence,
            })
            record.updates = (record.updates ?? 0) + 1
            const spent = Date.now() - started
            await new Promise((resolve) => { const t = setTimeout(resolve, Math.max(0, tick - spent)); t.unref?.() })
          }
          record.lastCardText = ''
        }
        if (text !== record.lastCardText) {
          card.sequence += 1
          await provider().card.update({ cardId: card.cardId, content: text, sequence: card.sequence })
          record.lastCardText = text
        }
        // Footer flips from "streaming" to "done" before the card freezes.
        try {
          card.sequence += 1
          await provider().card.update({
            cardId: card.cardId,
            content: '<font color="grey">完成</font>',
            sequence: card.sequence,
            elementId: 'note_1',
          })
        } catch { /* footer is cosmetic */ }
        card.sequence += 1
        try {
          await provider().card.close({
            cardId: card.cardId, sequence: card.sequence, summary: summaryOf(text),
          })
        } catch (error) {
          // The final write is the one that must land: back off once, then retry.
          if (!isRateLimited(error)) throw error
          await new Promise((resolve) => { const t = setTimeout(resolve, 1_500); t.unref?.() })
          card.sequence += 1
          await provider().card.close({
            cardId: card.cardId, sequence: card.sequence, summary: summaryOf(text),
          })
        }
        logInbound(config, {
          event: 'card', result: 'closed', sessionId, turn, cardId: card.cardId, chars: text.length,
          updates: record.updates ?? 0,
        })
        return
      } catch (error) {
        warnTo(ctx, `card finalize failed, falling back to text: ${errorText(error)}`)
        logInbound(config, { event: 'card', result: 'close-failed', sessionId, turn, reason: errorText(error) })
      }
    }
  }

  if (record.sentByTool) {
    logInbound(config, {
      event: 'reply', result: 'skipped', reason: 'already sent through feishu_send_message', sessionId, turn,
    })
    return
  }
  if (!chatId) {
    logInbound(config, { event: 'reply', result: 'skipped', reason: 'no chat for session', sessionId, turn })
    return
  }
  try {
    await sendChannelText(config, chatId, text)
    logInbound(config, { event: 'reply', result: 'sent', sessionId, turn, chatId, chars: text.length })
  } catch (error) {
    warnTo(ctx, `reply delivery failed: ${errorText(error)}`)
    logInbound(config, { event: 'reply', result: 'error', sessionId, turn, reason: errorText(error) })
  }
}

/** Durable-log feed: commit each step's text, then close the turn. */
export function observeSessionEvent(ctx, config, session, event) {
  // Any session in the Feishu workspace gets the channel's policy before its
  // tools run — including one opened from the GUI, not just inbound ones.
  if (event?.type === 'turn/start') applyWorkspacePermissionPreset(ctx, config, session)
  const target = activeSessionId(config)
  if (!target || session?.id !== target) return
  const data = event?.data ?? {}
  if (event.type === 'turn/start') {
    const record = turnRecord(target, data.turn)
    // Thinking process first (its create round trip overlaps the model's time to
    // first token), then the card placeholder.
    ensureCotRun(ctx, config, target, data.turn)
    void ensureCard(record, ctx, config).catch(() => {})
    return
  }
  if (event.type === 'tool/call') {
    if (data.name === 'feishu_send_message') turnRecord(target, data.turn).sentByTool = true
    const run = cotRuns.get(`${target}|${data.turn}`)
    if (run) {
      if (run.reasoningOpen) {
        run.reasoningOpen = false
        cotEnqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId: `reasoning-${data.turn}` }))
      }
      cotEnqueue(run,
        cotEvent('TOOL_CALL_START', {
          toolCallId: data.callId, icon: 'default', title: String(data.name ?? 'tool'), toolCallName: data.name,
        }),
        cotEvent('TOOL_CALL_ARGS', { toolCallId: data.callId, delta: String(data.arguments ?? '') }),
        cotEvent('TOOL_CALL_END', { toolCallId: data.callId }))
    }
    return
  }
  if (event.type === 'tool/result') {
    const run = cotRuns.get(`${target}|${data.turn}`)
    if (run) {
      const text = textOfMessage(data.message)
      cotEnqueue(run, cotEvent('TOOL_CALL_RESULT', {
        messageId: `result-${data.callId}`,
        toolCallId: data.callId,
        role: 'tool',
        content: { type: 'code', code: text.slice(0, 1500) },
        ...(data.error ? { error: String(data.error.code ?? 'error') } : {}),
      }))
    }
    return
  }
  if (event.type === 'assistant/message') {
    const record = turnRecord(target, data.turn)
    const text = textOfMessage(data.message)
    if (!text) return
    record.phase = 'answering'
    record.committed = record.committed ? `${record.committed}\n\n${text}` : text
    record.stepStream = ''
    record.stepBlocks = new Set()
    scheduleCardFlush(record, ctx, config)
    return
  }
  if (event.type === 'turn/end') {
    finishCotRun(config, target, data.turn, data.reason?.kind === 'error'
      ? (data.reason.error?.message ?? 'turn failed')
      : undefined)
    void finalizeTurn(ctx, config, target, data.turn, data.reason)
  }
}

/** Live stream feed: typewriter updates inside the current turn's card. */
export function observeAssistantStream(ctx, config, payload, sessionId, turnHint) {
  // DSH's emit carries `{ frame, agent }`; tests and older callers may pass `{ agent, frame }`.
  const agentId = sessionId ?? payload?.agent?.id ?? payload?.id
  const target = activeSessionId(config)
  if (!target || agentId !== target) {
    observeStats.mismatch += 1
    lastObserve = `mismatch target=${target} agent=${agentId}`
    return
  }
  const frame = payload?.frame
  if (!frame) {
    observeStats.noFrame += 1
    lastObserve = `no-frame keys=${describeShape(payload)}`
    return
  }
  // `chunk`/`end` frames carry no turn; the caller supplies the one from `start`.
  const turn = Number.isFinite(turnHint) ? turnHint : frame.turn
  if (!Number.isFinite(turn)) {
    observeStats.noFrame += 1
    lastObserve = `no-turn type=${String(frame.type)} keys=${describeShape(frame)}`
    return
  }
  const record = turnRecord(agentId, turn)
  if (frame.type === 'start') {
    observeStats.start += 1
    record.stepStream = ''
    return
  }
  if (frame.type !== 'chunk') {
    observeStats.end += 1
    lastObserve = `non-chunk type=${String(frame.type)}`
    return
  }
  observeStats.chunk += 1
  const chunk = frame.chunk
  // Reasoning goes to the native thinking process; only text builds the answer.
  if (chunk?.type === 'reasoning-delta') {
    streamChunks.reasoning += 1
    appendCotReasoning(cotRuns.get(`${target}|${turn}`) ?? ensureCotRun(ctx, config, target, turn), chunk.text)
    return
  }
  if (chunk?.type === 'block-end' && chunk.block?.type === 'reasoning') {
    streamChunks.reasoning += 1
    appendCotReasoning(cotRuns.get(`${target}|${turn}`) ?? ensureCotRun(ctx, config, target, turn), chunk.block.text)
    return
  }
  // `text-delta` is text by definition, so no block bookkeeping is needed —
  // requiring a prior block-start dropped every incremental update on the floor.
  if (chunk?.type !== 'text-delta') {
    streamChunks.other += 1
    return
  }
  streamChunks.text += 1
  record.phase = 'answering'
  record.stepStream += chunk.text
  scheduleCardFlush(record, ctx, config)
}

// ---------------------------------------------------------------------------
// Thinking process (native CoT) and acknowledgement reactions
//
// A thinking process is its own Feishu message: POST opens it, PUT appends
// AG-UI events, RUN_FINISHED closes it. It carries the reasoning and tool
// activity, never the answer — that stays in the streaming card.
// ---------------------------------------------------------------------------

const COT_EVENT_MAX_CHARS = 4096
const COT_BATCH = 50
const cotRuns = new Map()
const ackReactions = new Map()
let cotStamp = 0

/** Encode one AG-UI event with a strictly increasing timestamp and a bounded payload. */
export function cotEvent(type, content) {
  cotStamp = Math.max(Date.now(), cotStamp + 1)
  const encoded = JSON.stringify(content ?? {})
  return {
    event_type: type,
    content: encoded.length <= COT_EVENT_MAX_CHARS ? encoded : JSON.stringify({ truncated: true }),
    timestamp: String(cotStamp),
  }
}

async function cotDrain(run) {
  const handle = await run.opening
  if (!handle) {
    run.pending.length = 0
    return
  }
  while (run.pending.length > 0) {
    const batch = run.pending.splice(0, COT_BATCH)
    try {
      await provider().cotWrite({ cotId: handle.cotId, messageId: handle.messageId, events: batch })
    } catch (error) {
      run.pending.length = 0
      logInbound(run.config ?? {}, {
        event: 'cot', result: 'write-failed', reason: errorText(error), sessionId: run.sessionId, turn: run.turn,
      })
      break
    }
  }
}

function cotEnqueue(run, ...events) {
  if (run.finished && events.every((event) => event.event_type !== 'RUN_FINISHED' && event.event_type !== 'RUN_ERROR')) return
  run.pending.push(...events)
  run.draining = run.draining.then(() => cotDrain(run)).catch(() => {})
}

/** Open (once per turn) the thinking process; failures are presentation-only. */
export function ensureCotRun(ctx, config, sessionId, turn) {
  if (config.thinking === false) return undefined
  const key = `${sessionId}|${turn}`
  const existing = cotRuns.get(key)
  if (existing) return existing
  const chatId = replyTargetOf(config, sessionId)
  const run = {
    sessionId, turn, chatId, config, reasoningOpen: false, finished: false,
    pending: [], draining: Promise.resolve(),
    opening: (async () => {
      if (!chatId) return undefined
      try {
        const handle = await provider().cotCreate({ chatId, hidden: config.thinkingHidden === true })
        logInbound(config, {
          event: 'cot', result: 'opened', sessionId, turn, cotId: handle.cotId, messageId: handle.messageId,
        })
        return handle
      } catch (error) {
        logInbound(config, { event: 'cot', result: 'open-failed', reason: errorText(error), sessionId, turn })
        return undefined
      }
    })(),
  }
  cotRuns.set(key, run)
  cotEnqueue(run, cotEvent('RUN_STARTED', { threadId: chatId, runId: `turn-${turn}` }))
  return run
}

/** Close the run: a finished run, or the failure that ended the turn. */
export function finishCotRun(config, sessionId, turn, failure) {
  const key = `${sessionId}|${turn}`
  const run = cotRuns.get(key)
  if (!run || run.finished) return
  run.finished = true
  cotRuns.delete(key)
  if (run.reasoningOpen) {
    run.reasoningOpen = false
    cotEnqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId: `reasoning-${turn}` }))
  }
  cotEnqueue(run, failure
    ? cotEvent('RUN_ERROR', { message: String(failure).slice(0, 500), code: 'TURN_FAILED' })
    : cotEvent('RUN_FINISHED', { threadId: run.chatId, runId: `turn-${turn}`, status: 'done' }))
}

/** Reasoning text goes into the thinking process, never into the answer card. */
function appendCotReasoning(run, text) {
  if (!run || !text) return
  const messageId = `reasoning-${run.turn}`
  if (!run.reasoningOpen) {
    run.reasoningOpen = true
    cotEnqueue(run, cotEvent('REASONING_MESSAGE_START', { messageId, role: 'reasoning' }))
  }
  cotEnqueue(run, cotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta: text }))
}

const sendMessageTool = (config) => ({
  name: 'feishu_send_message',
  description:
    'Send a plain-text message through the dedicated DSH Feishu bot (飞书). '
    + 'The channel already delivers the final answer of every Feishu-originated turn back '
    + 'automatically, so do NOT call this just to reply in that conversation. Use it to push '
    + 'something to a DIFFERENT Feishu chat, or when explicit delivery is requested. '
    + '`text` is required; omit `receiveId` to use the configured defaultChatId. '
    + 'Returns the Feishu message id.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Message body, plain text (UTF-8).' },
      receiveId: {
        type: 'string',
        description: 'Destination id (chat_id like oc_..., or open_id/user_id/email of the receiver).',
      },
      receiveIdType: {
        type: 'string',
        enum: ['chat_id', 'open_id', 'user_id', 'email', 'union_id'],
        description: 'How to interpret receiveId. Defaults to chat_id for oc_... ids, else open_id.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        messageId: { type: 'string' },
        chatId: { type: 'string' },
      },
      required: ['ok'],
      additionalProperties: true,
    },
    render(args, value) {
      if (!value?.ok) return [{ type: 'text', text: `飞书发送失败: ${value?.error ?? 'unknown error'}` }]
      return [{
        type: 'text',
        text: `已发送到飞书${value.chatId ? ` (chat ${value.chatId})` : ''}: ${args.text}`,
      }]
    },
  },
  async execute(args, exec) {
    const target = requireReadiness(await provider().settingsAsync(), args)
    return await provider().sendText({ chatId: target.receiveId, text: String(args.text) }, exec?.signal)
  },
})

const sendFileTool = (config) => ({
  name: 'feishu_send_file',
  description:
    'Upload and send one local file through the Feishu bot: pictures (png/jpg/webp/gif/bmp) go as '
    + 'image messages, everything else (pdf/docx/xlsx/pptx/zip/mp4/text…) as file messages. '
    + 'Use it to deliver generated documents, screenshots, exports, or logs the user asked for. '
    + '`path` must name an existing file (images ≤ 10 MB, other files ≤ 30 MB).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the local file to send.' },
      name: { type: 'string', description: 'File name to show in Feishu (defaults to the path basename).' },
      receiveId: {
        type: 'string',
        description: 'Destination id (chat_id like oc_..., or open_id/user_id/email of the receiver).',
      },
      receiveIdType: {
        type: 'string',
        enum: ['chat_id', 'open_id', 'user_id', 'email', 'union_id'],
        description: 'How to interpret receiveId. Defaults to chat_id for oc_... ids, else open_id.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        kind: { type: 'string' },
        name: { type: 'string' },
        bytes: { type: 'number' },
        messageId: { type: 'string' },
      },
      required: ['ok'],
      additionalProperties: true,
    },
    render(_args, value) {
      if (!value?.ok) return [{ type: 'text', text: `飞书附件发送失败: ${value?.error ?? 'unknown error'}` }]
      const size = Number(value.bytes ?? 0)
      const human = size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`
      return [{ type: 'text', text: `已发送到飞书（${value.kind}）：${value.name} · ${human}` }]
    },
  },
  async execute(args, exec) {
    const target = requireReadiness(await provider().settingsAsync(), args)
    return await provider().sendAttachment(
      { chatId: target.receiveId, path: args.path, name: args.name },
      exec?.signal,
    )
  },
})

const statusTool = (config) => ({
  name: 'feishu_channel_status',
  description:
    'Report the DSH Feishu channel state: whether app credentials are present, which region and '
    + 'default destination are configured, and whether a tenant access token can be obtained.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: {
        configured: { type: 'boolean' },
        tokenOk: { type: 'boolean' },
        region: { type: 'string' },
        baseUrl: { type: 'string' },
        appId: { type: 'string' },
        defaultChatId: { type: 'string' },
        autoReply: { type: 'boolean' },
        streamingCards: { type: 'boolean' },
        permissionPreset: { type: 'string' },
        inboundReady: { type: 'boolean' },
        inboundTransport: { type: 'string' },
        inboundError: { type: 'string' },
        lastInboundAt: { type: 'number' },
        sessionId: { type: 'string' },
        workspacePath: { type: 'string' },
        streamFrames: { type: 'number' },
        streamWatchers: { type: 'number' },
        textChunks: { type: 'number' },
        reasoningChunks: { type: 'number' },
        otherChunks: { type: 'number' },
        flushScheduled: { type: 'number' },
        flushRan: { type: 'number' },
        streamShape: { type: 'string' },
        error: { type: 'string' },
      },
      required: ['configured', 'tokenOk'],
      additionalProperties: true,
    },
    render(_args, value) {
      if (!value?.configured) {
        return [{ type: 'text', text: `飞书通道未配置。${value?.error ?? ''}`.trim() }]
      }
      const head = value.tokenOk
        ? '飞书通道已配置，tenant_access_token 获取成功。'
        : `飞书通道已配置，但取 token 失败: ${value.error ?? 'unknown error'}`
      const inbound = value.inboundReady
        ? '入站长连接：已就绪'
        : `入站长连接：未就绪${value.inboundError ? `（${value.inboundError}）` : ''}`
      const last = value.lastInboundAt
        ? new Date(value.lastInboundAt).toLocaleString('zh-CN')
        : '(还没收到过)'
      return [{
        type: 'text',
        text: `${head}\nappId=${value.appId || '(env/file)'} region=${value.region} `
          + `defaultChatId=${value.defaultChatId || '(none)'}\n${inbound}`
          + `\n会话=${value.sessionId || '(none)'} 工作区=${value.workspacePath || '(none)'} `
          + `自动回传=${value.autoReply ? 'on' : 'off'} 流式卡片=${value.streamingCards ? 'on' : 'off'}`
          + `\n最近入站=${last}`
          + `\n流式帧=${value.streamFrames ?? 0} 订阅=${value.streamWatchers ?? 0}`
          + ` 文本块=${value.textChunks ?? 0} 思考块=${value.reasoningChunks ?? 0} 其它=${value.otherChunks ?? 0}`
          + `\n卡片调度=${value.flushScheduled ?? 0} 实跑=${value.flushRan ?? 0}`
          + (value.streamShape ? `\n首帧结构=${value.streamShape}` : '')
          + `\n观察：不符=${value.observeMismatch ?? 0} 无帧=${value.observeNoFrame ?? 0}`
          + ` start=${value.observeStart ?? 0} end=${value.observeEnd ?? 0} chunk=${value.observeChunk ?? 0}`
          + (value.lastObserve ? `\n最近=${value.lastObserve}` : ''),
      }]
    },
  },
  async execute(_args, exec) {
    const inbound = inboundSnapshot()
    const result = await provider().checkStatus(exec?.signal)
    return {
      ...result,
      autoReply: config.autoReply !== false,
      streamingCards: config.streamingCards !== false,
      permissionPreset: config.applyPermissionPreset === false
        ? ''
        : String(config.permissionPreset ?? 'danger-full-access'),
      inboundReady: Boolean(inbound.ready),
      inboundTransport: String(inbound.transport ?? ''),
      inboundError: String(inbound.error ?? ''),
      lastInboundAt: Number(inbound.lastInboundAt ?? 0),
      sessionId: String(currentSessionId(config) ?? ''),
      workspacePath: workspacePathFor(config),
      provider: provider().id,
      streamFrames: streamStats().frames,
      streamWatchers: streamStats().watchers,
      textChunks: streamStats().textChunks,
      reasoningChunks: streamStats().reasoningChunks,
      otherChunks: streamStats().otherChunks,
      flushScheduled: streamStats().flushScheduled,
      flushRan: streamStats().flushRan,
      streamShape: lastStreamShape,
      lastObserve,
      observeMismatch: observeStats.mismatch,
      observeNoFrame: observeStats.noFrame,
      observeStart: observeStats.start,
      observeEnd: observeStats.end,
      observeChunk: observeStats.chunk,
    }
  },
})

/**
 * The inbound message body. Deliberately the human's own words: routing, origin
 * and the reply path live in the plugin's sidecar state, never in the prompt.
 */
export function inboundUserText(text) {
  return String(text ?? '').trim()
}

const INBOUND_DEDUPE_LIMIT = 256

function warnTo(ctx, message) {
  try {
    ctx?.logger?.warn?.(`[feishu-channel] ${message}`)
  } catch {
    // logging must never break message delivery
  }
}

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
/**
 * Dedicated workspace for channel-created sessions, so they show up under their
 * own group in the GUI's workspace list instead of polluting a personal one.
 * Under the user's home (an app update replaces the install tree); override with
 * `workspacePath` in the row config.
 */
const DEFAULT_WORKSPACE_PATH = join(homedir(), 'dsh-feishu')
const DEFAULT_WORKSPACE_TITLE = '飞书'

/** Directory a Feishu-created session uses as cwd. */
export function workspacePathFor(config) {
  return String(config?.workspacePath ?? '').trim() || DEFAULT_WORKSPACE_PATH
}

/** Directory used when `sessionMode` has to create a session. */
export function createCwdFor(config) {
  return String(config?.cwd ?? '').trim() || workspacePathFor(config)
}

/**
 * Find or create the Feishu workspace and attach one freshly created session.
 *
 * DSH validates the link: `attachSession()` reads the session header's `cwd`
 * and refuses unless it resolves to the workspace directory, so this must run
 * for sessions whose cwd is exactly `workspacePathFor()`. Every step is
 * best-effort — a host without `workspaceRegistry` (or an older/newer DSH whose
 * service shape moved) must not break message delivery.
 */
async function attachToFeishuWorkspace(ctx, config, sessionId) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (!registry || typeof registry.resolveByPath !== 'function') {
      warnTo(ctx, 'workspaceRegistry unavailable: session stays ungrouped')
      return false
    }
    const path = workspacePathFor(config)
    let workspace = await registry.resolveByPath(path)
    if (!workspace) {
      workspace = await registry.create(path, DEFAULT_WORKSPACE_TITLE)
      logInbound(config, { event: 'workspace', result: 'created', path })
    }
    if (typeof workspace?.attachSession !== 'function') {
      warnTo(ctx, 'workspace attaches skipped: attachSession missing')
      return false
    }
    await workspace.attachSession(sessionId)
    logInbound(config, { event: 'workspace', result: 'attached', path, sessionId })
    return true
  } catch (error) {
    warnTo(ctx, `workspace attach failed: ${errorText(error)}`)
    logInbound(config, { event: 'workspace', result: 'error', reason: errorText(error), sessionId })
    return false
  }
}
/**
 * Apply the channel's permission preset to a session the channel will drive.
 *
 * A Feishu turn runs unattended: an `ask` policy has nobody in front of the GUI
 * to answer it, so the session would stall on its first approval. `set()` records
 * the switch durably and is a no-op when the knobs already match, which makes it
 * safe to run on every activation. Configure with `permissionPreset` (default
 * `danger-full-access`) or disable with `applyPermissionPreset: false`.
 *
 * `target` may be an Agent (its `session`) or a Session.
 */
function applyPermissionPreset(ctx, config, target) {
  const name = String(config.permissionPreset ?? 'danger-full-access').trim()
  if (!name || config.applyPermissionPreset === false) return false
  const session = target?.session ?? target
  if (!session?.id) return false
  try {
    const presets = typeof ctx.get === 'function' ? ctx.get('permissionPresets') : undefined
    if (!presets || typeof presets.set !== 'function') {
      warnTo(ctx, 'permissionPresets unavailable: the session keeps its own policy')
      return false
    }
    const current = typeof presets.current === 'function' ? presets.current(session) : ''
    if (current === name) return true
    presets.set(session, name)
    logInbound(config, { event: 'permission', result: 'applied', preset: name, from: current, sessionId: session.id })
    return true
  } catch (error) {
    warnTo(ctx, `permission preset "${name}" failed: ${errorText(error)}`)
    logInbound(config, {
      event: 'permission', result: 'error', preset: name, reason: errorText(error), sessionId: session.id,
    })
    return false
  }
}

const normalizePath = (value) => String(value ?? '').trim().replace(/[\\/]+$/, '').toLowerCase()

/**
 * Every session living in the Feishu workspace belongs to this channel, including
 * one the user opened from the GUI: give it the same unattended policy.
 */
export function applyWorkspacePermissionPreset(ctx, config, session) {
  const workspace = normalizePath(workspacePathFor(config))
  if (!workspace) return false
  if (normalizePath(session?.header?.cwd) !== workspace) return false
  return applyPermissionPreset(ctx, config, session)
}

/** Titles a model falls back to when it has nothing to say; the prompt's own words are better. */
const TITLE_PLACEHOLDERS = new Set([
  'greeting', 'new session', 'new chat', 'untitled', 'session', '新会话', '未命名', '会话',
])

/** A short, human title derived from the first message. */
export function deriveTitle(text, max = 24) {
  const line = String(text ?? '').split('\n').map((value) => value.trim()).find(Boolean) ?? ''
  const cleaned = line
    .replace(/^[#>*\-\s]+/u, '')
    .replace(/[`*_>[\]()#]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!cleaned) return ''
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}

/**
 * Make sure a live session carries a title *before* it shows up in the workspace
 * list. The title model runs first (a real summary of the prompt); if it is slow
 * or fails, the first line of the message is pinned instead, because the list row
 * is read from the projection cache at attach time and a late title does not
 * always refresh it.
 */
export async function ensureSessionTitle(ctx, config, session, text) {
  const titles = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
  if (!titles || typeof titles.rename !== 'function') return ''
  const existing = typeof titles.get === 'function' ? titles.get(session) : undefined
  const existingTitle = String(existing?.title ?? '').trim()
  if (existingTitle && !TITLE_PLACEHOLDERS.has(existingTitle.toLowerCase())) return existingTitle
  if (typeof titles.refresh === 'function') {
    try {
      const timeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(6_000) : undefined
      const snapshot = await titles.refresh(session, timeout)
      const generated = String(snapshot?.title ?? '').trim()
      if (generated && !TITLE_PLACEHOLDERS.has(generated.toLowerCase())) {
        logInbound(config, { event: 'title', result: 'generated', title: generated, sessionId: session.id })
        return generated
      }
    } catch (error) {
      logInbound(config, { event: 'title', result: 'provider-failed', reason: errorText(error), sessionId: session.id })
    }
  }
  const fallback = deriveTitle(text)
  if (!fallback) return ''
  try {
    const snapshot = titles.rename(session, fallback)
    const title = snapshot?.title ?? fallback
    logInbound(config, { event: 'title', result: 'fallback', title, sessionId: session.id })
    return title
  } catch (error) {
    logInbound(config, { event: 'title', result: 'error', reason: errorText(error), sessionId: session.id })
    return ''
  }
}

const IDLE_RELEASE_CHECK_MS = 60_000
const IDLE_PROBE_MS = 2_000

/** The one plugin-owned live agent, activated on demand for the inbound session. */
let ownedHandle
let lastInboundAt = 0

/** Inbound transport state, reported by `feishu_channel_status` and the log. */
let inboundState = { ready: false, error: '', at: 0, transport: '' }

export function inboundSnapshot() {
  return { ...inboundState, lastInboundAt }
}

function setInboundState(config, next) {
  inboundState = { ...inboundState, ...next, at: Date.now() }
  logInbound(config, { event: 'channel', ...next })
}

const errorText = (error) => (error instanceof Error ? error.message : String(error))

/** Inbound diagnostics land next to the credentials unless `logFile` says otherwise. */
function inboundLogPath(config) {
  return String(config.logFile ?? '').trim() || join(dirname(credentialsFilePath()), 'feishu-inbound.log')
}

/** Append one JSONL diagnostic record. Must never throw into the delivery path. */
function logInbound(config, record) {
  try {
    appendFileSync(inboundLogPath(config), `${JSON.stringify({ time: Date.now(), ...record })}\n`)
  } catch {
    // a broken log path must not break message delivery
  }
}

/** Default provider/model route, when the profile exposes the default-model service. */
function agentOptionsFor(ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    const selection = service?.currentSelection?.()
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    // optional service; the agent loop falls back to its own defaults
  }
  return undefined
}

/**
 * Build the pre-publication `setup` that binds an agent preset — the same
 * composition the app's own session controller applies when it opens a
 * session. Without it a resumed agent only sees globally registered tools
 * (measured on this machine: 16 tools vs 39 with the preset mounted).
 *
 * The preset comes from the stored session (`sessionQuery` observation), which
 * is what the controller does, unless the row config pins `preset`.
 */
async function presetCompositionFor(ctx, config, sessionId) {
  const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
  if (presets?.resolve === undefined || presets?.mount === undefined) return {}
  let presetId = String(config.preset ?? '').trim() || undefined
  if (presetId === undefined && typeof sessionId === 'string' && sessionId.length > 0) {
    let observation
    try {
      observation = await ctx.get?.('sessionQuery')?.observeSession?.(sessionId)
      presetId = observation?.projections?.values?.agentPreset
        ?? observation?.header?.agentPreset
        ?? undefined
    } catch {
      presetId = undefined // nothing stored yet: resolve the configured default
    } finally {
      try { observation?.[Symbol.dispose]?.() } catch { /* best effort */ }
      try { await observation?.[Symbol.asyncDispose]?.() } catch { /* best effort */ }
    }
  }
  const resolved = await presets.resolve(presetId)
  return {
    agentPreset: resolved?.id,
    setup: async (agentCtx) => { await presets.mount(agentCtx, resolved?.id) },
  }
}

/**
 * Resolve an agent for inbound delivery without requiring the session to be
 * open in the app:
 *   1. a live agent wins — the app's own session controller reuses it the same
 *      way, so the GUI can attach to this very agent afterwards;
 *   2. otherwise `resume` the persisted session (`sessionMode: "resume"`),
 *      which is what DSH's headless ACP client does;
 *   3. with `sessionMode: "create"`, create the session when nothing is
 *      persisted yet (`cwd` from the row config, else this plugin's workspace).
 */
async function resolveInboundAgent(ctx, config) {
  const sessionId = currentSessionId(config)
  const live = ctx.agents?.get?.(sessionId)
  if (live) {
    applyPermissionPreset(ctx, config, live)
    return { agent: live, via: 'live' }
  }
  if (ownedHandle && ctx.agents?.get?.(ownedHandle.agent.session.id) === ownedHandle.agent) {
    applyPermissionPreset(ctx, config, ownedHandle.agent)
    return { agent: ownedHandle.agent, via: 'owned' }
  }

  const mode = String(config.sessionMode ?? 'resume').toLowerCase()
  if (mode === 'off') return { reason: 'sessionMode is "off" and no live agent exists' }

  const agentOptions = agentOptionsFor(ctx)
  let resumeFailure
  const composition = await presetCompositionFor(ctx, config, sessionId)
  const presetLabel = composition.agentPreset === undefined ? '' : `(preset=${composition.agentPreset})`
  try {
    ownedHandle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions,
      setup: composition.setup,
    })
    applyPermissionPreset(ctx, config, ownedHandle.agent)
    return { agent: ownedHandle.agent, via: `resume${presetLabel}` }
  } catch (error) {
    resumeFailure = errorText(error)
    if (mode !== 'create') return { reason: `resume failed: ${resumeFailure}` }
  }

  const cwd = createCwdFor(config)
  try {
    ownedHandle = await ctx.agents.create({
      sessionId,
      agentOptions,
      meta: {
        cwd,
        ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
      },
      setup: composition.setup,
    })
    applyPermissionPreset(ctx, config, ownedHandle.agent)
    // The workspace attach happens after the first prompt is delivered and the
    // session is named, so the list row never appears unnamed (see
    // ensureSessionTitle); the caller publishes it.
    return { agent: ownedHandle.agent, via: `create(cwd=${cwd})${presetLabel}`, created: true }
  } catch (error) {
    return { reason: `create failed: ${errorText(error)} (resume failed: ${resumeFailure})` }
  }
}

/** Whether the agent has no turn in flight; `whenIdle()` resolves at quiescence. */
async function isAgentIdle(agent) {
  try {
    const idle = agent?.whenIdle?.()
    if (!idle) return true
    const probe = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), IDLE_PROBE_MS)
      timer.unref?.()
    })
    return await Promise.race([Promise.resolve(idle).then(() => true), probe])
  } catch {
    return false
  }
}

function lastSessionEventTime(handle) {
  try {
    return Number(handle?.agent?.session?.log?.at(-1)?.time ?? 0)
  } catch {
    return 0
  }
}

/**
 * Release the plugin-owned agent once the channel has been quiet for
 * `idleReleaseMinutes` (0 keeps it until the plugin unloads). Releasing is
 * safe: the app's controller re-resumes the session on demand, and only the
 * first writer is exclusive. Never releases with a turn in flight.
 */
export async function releaseOwnedAgentIfIdle(config) {
  if (!ownedHandle) return
  const minutes = Number(config.idleReleaseMinutes ?? 30)
  if (!Number.isFinite(minutes) || minutes <= 0) return
  const idleFor = Date.now() - Math.max(lastInboundAt, lastSessionEventTime(ownedHandle))
  if (idleFor < minutes * 60_000) return
  const handle = ownedHandle
  if (!(await isAgentIdle(handle.agent))) return
  ownedHandle = undefined
  try {
    await handle.dispose()
  } catch (error) {
    logInbound(config, { event: 'release', result: 'error', reason: errorText(error) })
    return
  }
  logInbound(config, { event: 'release', result: 'released', idleMinutes: Math.round(idleFor / 60_000) })
}

/** Where the channel remembers which conversation `/new` switched to. */
function channelStatePath(config) {
  return String(config.stateFile ?? '').trim()
    || join(dirname(credentialsFilePath()), 'feishu-channel-state.json')
}

function readChannelState(config) {
  try {
    const parsed = JSON.parse(readFileSync(channelStatePath(config), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeChannelState(config, patch) {
  try {
    const next = { ...readChannelState(config), ...patch, updatedAt: Date.now() }
    writeFileSync(channelStatePath(config), `${JSON.stringify(next, null, 2)}\n`)
    return true
  } catch (error) {
    logInbound(config, { event: 'session', result: 'state-write-failed', reason: errorText(error) })
    return false
  }
}

/** The conversation inbound messages go to: the `/new` state first, then the row config. */
function currentSessionId(config) {
  return String(readChannelState(config).sessionId ?? '').trim()
    || String(config.sessionId ?? '').trim()
}

/** Send one plain-text message through the provider (used for `/new` confirmation). */
async function sendChannelText(config, chatId, text, signal) {
  return await provider().sendText({ chatId, text }, signal)
}

/**
 * Create a brand-new conversation and make it the channel's current one.
 * `/new` survives restarts because the id lands in `stateFile`; the previous
 * plugin-owned agent is handed back as soon as it is idle.
 */
async function switchToNewSession(ctx, config, { chatId, senderId, firstMessage }) {
  const sessionId = `session-${randomUUID()}`
  const cwd = createCwdFor(config)
  const composition = await presetCompositionFor(ctx, config, undefined)
  let handle
  try {
    handle = await ctx.agents.create({
      sessionId,
      agentOptions: agentOptionsFor(ctx),
      meta: {
        cwd,
        ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
      },
      setup: composition.setup,
    })
  } catch (error) {
    warnTo(ctx, `failed to create a new session: ${errorText(error)}`)
    logInbound(config, { event: 'session', result: 'create-failed', reason: errorText(error), senderId, chatId })
    return
  }
  // Publish it under the Feishu workspace once it can be named (see below); an
  // unnamed row in the list is worse than a one-second delay.
  applyPermissionPreset(ctx, config, handle.agent)

  const previous = ownedHandle
  ownedHandle = handle
  writeChannelState(config, { sessionId })
  invalidateActiveSession()
  lastInboundAt = Date.now()
  if (previous && previous !== handle && (await isAgentIdle(previous.agent))) {
    void Promise.resolve(previous.dispose()).catch(() => {})
  }
  logInbound(config, { event: 'session', result: 'switched', sessionId, cwd, via: '/new', senderId, chatId })

  if (firstMessage) {
    try {
      await handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: inboundUserText(firstMessage) }],
        source: { kind: 'user' },
      })
      rememberChat(config, sessionId, { chatId, senderId })
    } catch (error) {
      warnTo(ctx, `delivery into the new session failed: ${errorText(error)}`)
      logInbound(config, { event: 'inbound', result: 'error', reason: errorText(error), sessionId, senderId, chatId })
    }
    try {
      await ensureSessionTitle(ctx, config, handle.agent.session, firstMessage)
    } catch (error) {
      warnTo(ctx, `session title failed: ${errorText(error)}`)
    }
    await attachToFeishuWorkspace(ctx, config, sessionId)
    return
  }

  await attachToFeishuWorkspace(ctx, config, sessionId)
  if (config.notifyOnNew === false) return
  try {
    await sendChannelText(config, chatId, `已开新会话 ${sessionId}，接下来发消息都会进入这段对话。`)
  } catch (error) {
    warnTo(ctx, `new-session confirmation failed: ${errorText(error)}`)
    logInbound(config, { event: 'session', result: 'confirm-failed', reason: errorText(error), sessionId, chatId })
  }
}

// ---------------------------------------------------------------------------
// Slash commands
//
// Control phrases are handled here and never reach the model: they must not
// spend a turn, pollute the conversation, or be mistaken for a task.
// ---------------------------------------------------------------------------

const HELP_TEXT = [
  '可用命令：',
  '/help — 这条说明',
  '/status — 当前会话、工作区、权限与入站状态',
  '/new [内容] — 开一段新会话（带内容则作为第一条消息）',
  '/rename <标题> — 给当前会话改名',
  '/stop — 中断进行中的回合',
].join('\n')

/** Parse `/name args`; null when the text is not a command. */
export function parseSlashCommand(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('/')) return null
  const body = trimmed.slice(1)
  if (!body.trim()) return { name: '', args: '', raw: trimmed }
  const match = /^([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(body)
  if (!match) return { name: '', args: body.trim(), raw: trimmed }
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim(), raw: trimmed }
}

/** Interrupt the running turn of the channel's session, if any. */
export async function stopTurn(ctx, config) {
  const sessionId = currentSessionId(config)
  if (!sessionId) return { text: '当前没有会话可停止。', reason: 'no-session' }
  const agent = ctx?.agents?.get?.(sessionId)
  if (!agent) return { text: '当前会话没有在运行。', reason: 'no-agent' }
  if (agent.status !== 'running') return { text: '当前没有进行中的回合。', reason: 'idle' }
  if (typeof agent.cancel !== 'function') return { text: '这个宿主不支持中断当前回合。', reason: 'unsupported' }
  agent.cancel({ kind: 'user' })
  return { text: '已请求中断当前回合。', reason: 'cancelled' }
}

/** Human-readable channel state for `/status`. */
export async function statusText(ctx, config, chatId) {
  const settings = await provider().settingsAsync()
  const sessionId = currentSessionId(config)
  const inbound = inboundSnapshot()
  const agent = sessionId ? ctx?.agents?.get?.(sessionId) : undefined
  let title = ''
  try {
    const snapshot = ctx?.get?.('sessionTitle')?.get?.(agent?.session)
    title = String(snapshot?.title ?? '')
  } catch { /* title is optional */ }
  const preset = config.applyPermissionPreset === false
    ? '(按会话自身策略)'
    : String(config.permissionPreset ?? 'danger-full-access')
  return [
    `会话：${sessionId || '(未配置)'}`,
    ...(title ? [`标题：${title}`] : []),
    `运行：${agent ? (agent.status === 'running' ? '回合进行中' : '空闲') : '未激活'}`,
    `工作区：${workspacePathFor(config)}`,
    `权限：${preset}`,
    `入站：${inbound.ready ? '已就绪' : `未就绪${inbound.error ? `（${inbound.error}）` : ''}`}`,
    `目标群：${chatId || settings.defaultChatId || '(无)'}`,
    `提供方：${provider().id}`,
  ].join('\n')
}

/**
 * Handle one control phrase. Returns true when it was consumed here, so the
 * caller must not deliver the text to the agent.
 */
export async function handleSlashCommand(ctx, config, { name, args, chatId, senderId }) {
  const log = (result, extra = {}) => logInbound(config, {
    event: 'slash', command: name || '(empty)', result, senderId, chatId, ...extra,
  })
  const reply = async (text) => {
    try {
      await sendChannelText(config, chatId, text)
      return true
    } catch (error) {
      warnTo(ctx, `slash reply failed: ${errorText(error)}`)
      log('reply-failed', { reason: errorText(error) })
      return false
    }
  }

  if (!name) {
    // A bare `/` is someone looking for the command list, not a typo.
    await reply(String(args ?? '').trim() ? `未识别的命令。\n\n${HELP_TEXT}` : HELP_TEXT)
    log('help')
    return true
  }

  switch (name) {
    case 'help':
    case '?':
      await reply(HELP_TEXT)
      log('help')
      return true

    case 'status':
      await reply(await statusText(ctx, config, chatId))
      log('status')
      return true

    case 'stop': {
      const result = await stopTurn(ctx, config)
      await reply(result.text)
      log('stop', { reason: result.reason })
      return true
    }

    case 'new':
      await switchToNewSession(ctx, config, { chatId, senderId, firstMessage: args })
      log('new', { firstMessage: args ? 'yes' : 'no' })
      return true

    case 'rename': {
      const title = args.trim()
      if (!title) {
        await reply('用法：/rename 新的标题')
        log('rename', { reason: 'missing-title' })
        return true
      }
      const agent = ctx?.agents?.get?.(currentSessionId(config))
      const titles = typeof ctx?.get === 'function' ? ctx.get('sessionTitle') : undefined
      if (!agent || typeof titles?.rename !== 'function') {
        await reply('当前会话未激活，或这个宿主不支持改名。')
        log('rename', { reason: 'unsupported' })
        return true
      }
      try {
        const snapshot = titles.rename(agent.session, title)
        await reply(`已改名为「${snapshot?.title ?? title}」。`)
        log('rename', { result2: 'ok' })
      } catch (error) {
        await reply(`改名失败：${errorText(error)}`)
        log('rename', { reason: errorText(error) })
      }
      return true
    }

    default:
      await reply(`未识别的命令 /${name}。\n\n${HELP_TEXT}`)
      log('unknown')
      return true
  }
}

export async function handleInboundEvent(ctx, config, data, seen) {
  const log = (record) => logInbound(config, record)
  // The provider decides what the event means (text, rich text, image, ignored).
  const inbound = provider().parseInbound(data)
  if (!inbound) return
  const eventId = inbound.dedupeKey
  if (eventId) {
    if (seen.has(eventId)) return
    seen.add(eventId)
    if (seen.size > INBOUND_DEDUPE_LIMIT) seen.delete(seen.values().next().value)
  }

  if (inbound.senderType === 'app') return

  const senderId = inbound.senderId
  const allowed = Array.isArray(config.allowedUsers)
    ? config.allowedUsers.map((value) => String(value)).filter(Boolean)
    : []
  if (allowed.length > 0 && !allowed.includes(senderId)) {
    warnTo(ctx, `ignored message from ${senderId}: not in allowedUsers`)
    log({ event: 'inbound', result: 'dropped', reason: 'sender not in allowedUsers', senderId })
    return
  }

  const chatId = inbound.chatId
  if (inbound.unsupported) {
    warnTo(ctx, `ignored unsupported message_type=${inbound.unsupported}`)
    log({ event: 'inbound', result: 'dropped', reason: `non-text message_type=${inbound.unsupported}`, senderId })
    return
  }

  let text = inbound.text
  const imageKeys = inbound.imageKeys
  if (imageKeys.length > 0) {
    const messageId = inbound.messageId
    if (!messageId) {
      log({ event: 'inbound', result: 'image-error', reason: 'message_id missing', senderId, chatId })
    } else {
      const saved = []
      for (const key of imageKeys.slice(0, 4)) {
        try {
          saved.push(await provider().downloadImage({ messageId, imageKey: key }))
        } catch (error) {
          log({ event: 'inbound', result: 'image-error', reason: errorText(error), senderId, chatId })
        }
      }
      if (saved.length > 0) {
        const refs = saved.map((path, index) => (saved.length === 1 ? `[图片] ${path}` : `[图片${index + 1}] ${path}`))
        text = [text, ...refs].filter(Boolean).join('\n')
        log({ event: 'inbound', result: 'images', count: saved.length, senderId, chatId })
      }
    }
  }

  if (!text) {
    log({ event: 'inbound', result: 'dropped', reason: 'empty text', senderId, chatId })
    return
  }

  // Control phrases are consumed here, never delivered to the model.
  // `/new` still starts a fresh conversation; `/help` lists the rest.
  // Any accepted inbound counts as channel activity, commands included, so the
  // idle-release timer and `/status` see the truth.
  lastInboundAt = Date.now()
  const command = parseSlashCommand(text)
  if (command) {
    await handleSlashCommand(ctx, config, { ...command, chatId, senderId })
    return
  }

  const sessionId = currentSessionId(config)
  if (!sessionId) {
    warnTo(ctx, 'inbound message dropped: no sessionId configured')
    log({ event: 'inbound', result: 'dropped', reason: 'no sessionId configured', senderId, chatId })
    return
  }

  const resolved = await resolveInboundAgent(ctx, config)
  if (!resolved.agent) {
    warnTo(ctx, `inbound message dropped for session "${sessionId}": ${resolved.reason}`)
    log({ event: 'inbound', result: 'dropped', reason: resolved.reason, senderId, chatId, sessionId })
    return
  }

  // The inbox item must be a fully identified user message, exactly like a Web
  // submission: `id` + `role` + `source` + `content`. Both fields are load-
  // bearing:
  //   - missing `role` makes the next model request invalid (the API rejects the
  //     whole request with "messages[N]: missing field `role`", HTTP 422);
  //   - missing `id` stores a log the loader refuses on the next load
  //     ("session event at seq N lacks an identified message"), which leaves the
  //     session unopenable until the record is repaired.
  // DSH only validates identity when reading the log, not when appending, so a
  // raw `{ content, source }` followup corrupts the session silently.
  lastInboundAt = Date.now()
  try {
    await resolved.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: inboundUserText(text) }],
      source: { kind: 'user' },
    })
    rememberChat(config, sessionId, { chatId, senderId })
    // Acknowledge on the user's own message: the cheapest "I got it" there is.
    if (config.reactions !== false && inbound.messageId) {
      void provider().addReaction({ messageId: inbound.messageId })
        .then((reactionId) => {
          if (reactionId) {
            ackReactions.set(sessionId, { messageId: inbound.messageId, reactionId })
            log({ event: 'reaction', result: 'added', messageId: inbound.messageId })
          }
        })
        .catch((error) => log({ event: 'reaction', result: 'failed', reason: errorText(error) }))
    }
  } catch (error) {
    warnTo(ctx, `inbound delivery failed for session "${sessionId}": ${errorText(error)}`)
    log({ event: 'inbound', result: 'error', reason: errorText(error), senderId, chatId, sessionId, via: resolved.via })
    if (resolved.created) await attachToFeishuWorkspace(ctx, config, sessionId)
    return
  }

  // Name first, publish second: the workspace list row is read from the
  // projection cache when the session is attached, so attaching before a title
  // exists leaves a nameless entry in the list.
  try {
    await ensureSessionTitle(ctx, config, resolved.agent.session, text)
  } catch (error) {
    warnTo(ctx, `session title failed: ${errorText(error)}`)
  }
  if (resolved.created) await attachToFeishuWorkspace(ctx, config, sessionId)

  warnTo(ctx, `delivered inbound Feishu message from ${senderId} to session ${sessionId} (${resolved.via})`)
  log({ event: 'inbound', result: 'delivered', senderId, chatId, sessionId, via: resolved.via })
}

function startInbound(ctx, config) {
  ctx.inject(['agents'], (scoped) => {
    scoped.effect(() => {
      let disposed = false
      const seen = new Set()

      // Outbound half: the answer to every inbound message travels back through
      // the durable-log feed, so no prompt instruction is needed.
      loadChatMemory(config)
      channelRuntime = { ctx: scoped, config }
      // The active session may already be live from an earlier message; its
      // policy must match the channel's preset even before the next inbound one,
      // and live tokens arrive only on the agent's own context.
      try {
        for (const liveAgent of scoped.agents?.list?.() ?? []) {
          applyWorkspacePermissionPreset(scoped, config, liveAgent.session ?? liveAgent)
          watchAgentStreams(liveAgent, channelRuntime)
        }
      } catch { /* best effort */ }
      const offSessionEvent = scoped.on?.('session/event', (session, event) => {
        if (event?.type === 'turn/start') watchAgentStreams(scoped.agents?.get?.(session?.id), channelRuntime)
        observeSessionEvent(scoped, config, session, event)
      })

      // Periodically hand back an idle plugin-owned agent; the app re-resumes
      // the session on demand, so a quiet channel costs nothing.
      const releaseTimer = setInterval(() => {
        void releaseOwnedAgentIfIdle(config).catch(() => {})
      }, IDLE_RELEASE_CHECK_MS)
      releaseTimer.unref?.()

      let connectionCleanup = () => {}
      void (async () => {
        const cleanup = await provider().connect({
          onEvent: async (data) => {
            try {
              await handleInboundEvent(scoped, config, data, seen)
            } catch (error) {
              warnTo(scoped, `inbound handler failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          },
          onState: ({ ready, error }) => {
            setInboundState(config, { ready: Boolean(ready), transport: 'websocket', error: String(error ?? '') })
            if (ready) warnTo(scoped, 'inbound long connection ready')
            else if (error && error !== 'closed') warnTo(scoped, `inbound connection problem: ${error}`)
          },
        })
        if (disposed) {
          try { cleanup() } catch { /* already closing */ }
        } else {
          connectionCleanup = cleanup
        }
      })()

      return () => {
        disposed = true
        clearInterval(releaseTimer)
        try { offSessionEvent?.() } catch { /* ignore */ }
        try { connectionCleanup() } catch { /* ignore */ }
        disposeAgentStreams()
        channelRuntime = undefined
        setInboundState(config, { ready: false, transport: 'websocket', error: 'closed' })
        const handle = ownedHandle
        ownedHandle = undefined
        if (handle) void Promise.resolve(handle.dispose()).catch(() => {})
      }
    })
  })
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  activeProvider = resolveProvider(config, {
    log: (record) => logInbound(config, record),
    credentials: typeof ctx.get === 'function' ? ctx.get('credentials') : undefined,
  })
  ctx.effect?.(() => () => { activeProvider = undefined })
  ctx.tools.register(sendMessageTool(config))
  ctx.tools.register(sendFileTool(config))
  ctx.tools.register(statusTool(config))
  if (config.inboundEnabled === true) startInbound(ctx, config)
}
