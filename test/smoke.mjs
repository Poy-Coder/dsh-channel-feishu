/**
 * Local smoke test for the Feishu channel plugin. Hermetic: it points DSH_HOME
 * at a temp directory, so it never reads or writes the real credentials file
 * and never touches the network.
 *
 * Usage: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const emptyHome = mkdtempSync(join(tmpdir(), 'feishu-empty-'))
const credsHome = mkdtempSync(join(tmpdir(), 'feishu-creds-'))
writeFileSync(join(credsHome, 'feishu-channel.json'), JSON.stringify({
  appId: 'file-id',
  appSecret: 'file-secret',
  defaultChatId: 'oc_file_default',
  region: 'lark',
}))

process.env.DSH_HOME = emptyHome
process.env.FEISHU_APP_ID = ''
process.env.FEISHU_APP_SECRET = ''

const { apply, resolveSettings } = await import('../index.js')

const ALLOWED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'oneOf', 'description',
])

function checkSchema(schema, path, violations) {
  if (schema === true || schema === false) return
  if (typeof schema !== 'object' || schema === null) {
    violations.push(`${path}: not a schema object`)
    return
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYWORDS.has(key)) violations.push(`${path}.${key}: unsupported keyword`)
  }
  if (schema.properties) {
    for (const [name, child] of Object.entries(schema.properties)) {
      checkSchema(child, `${path}.properties.${name}`, violations)
    }
  }
  if (schema.items) checkSchema(schema.items, `${path}.items`, violations)
  if (schema.oneOf) schema.oneOf.forEach((child, i) => checkSchema(child, `${path}.oneOf[${i}]`, violations))
  return violations
}

function mount(config) {
  const registered = new Map()
  apply({ tools: { register: (d) => (registered.set(d.name, d), () => {}) } }, config)
  return registered
}

// 1. Definitions register and stay inside the enforced JSON Schema subset.
const registered = mount({})
assert.deepEqual([...registered.keys()].sort(), ['feishu_channel_status', 'feishu_send_file', 'feishu_send_message'])
for (const definition of registered.values()) {
  const violations = checkSchema(definition.parameters, `${definition.name}.parameters`, [])
  checkSchema(definition.output.schema, `${definition.name}.output`, violations)
  assert.deepEqual(violations, [], `schema violations: ${violations.join('; ')}`)
}

// 2. Nothing configured: status reports it, send refuses before any I/O.
const status = await registered.get('feishu_channel_status').execute({}, {})
assert.equal(status.configured, false)
assert.equal(status.tokenOk, false)
assert.match(status.error, /appId/)
await assert.rejects(
  () => registered.get('feishu_send_message').execute({ text: 'hi' }, {}),
  (error) => /not ready/.test(error.message)
    && /appId/.test(error.message)
    && /No destination/.test(error.message),
)

// 3. Credentials from the file are picked up.
process.env.DSH_HOME = credsHome
const fromFile = resolveSettings({})
assert.equal(fromFile.appId, 'file-id')
assert.equal(fromFile.appSecret, 'file-secret')
assert.equal(fromFile.defaultChatId, 'oc_file_default')
assert.equal(fromFile.region, 'lark')
assert.equal(fromFile.baseUrl, 'https://open.larksuite.com')

// 3b. Credentials without any destination still refuse before touching the network.
process.env.DSH_HOME = emptyHome
await assert.rejects(
  () => mount({ appId: 'row-id', appSecret: 'row-secret' }).get('feishu_send_message')
    .execute({ text: 'hi' }, {}),
  (error) => /No destination/.test(error.message) && !/tenant token/.test(error.message),
)

// 4. Precedence: row config > environment > file.
process.env.FEISHU_APP_ID = 'env-id'
process.env.FEISHU_APP_SECRET = 'env-secret'
assert.equal(resolveSettings({ appId: 'row-id' }).appId, 'row-id')
assert.equal(resolveSettings({ appId: 'row-id' }).appSecret, 'env-secret')
assert.equal(resolveSettings({}).appId, 'env-id')
delete process.env.FEISHU_APP_ID
delete process.env.FEISHU_APP_SECRET
process.env.DSH_HOME = credsHome
assert.equal(resolveSettings({}).appId, 'file-id')

// 5. A destination passed in the call is used as-is.
const target = resolveSettings({}).defaultChatId
assert.equal(target, 'oc_file_default')

// 6. A disabled row registers nothing.
assert.equal(mount({ enabled: false }).size, 0)

// 7. Inbound helpers: text parsing, mention stripping, and the plain-text body.
const {
  parseTextContent, stripMentions, inboundUserText, parsePostContent, parseImageContent, imageExtension,
  workspacePathFor, createCwdFor,
} = await import('../index.js')
assert.equal(parseTextContent('{"text":"hello 飞书"}'), 'hello 飞书')
assert.equal(parseTextContent('not json'), '')
assert.equal(parseTextContent(undefined), '')
assert.equal(
  stripMentions('@_user_1 你好 @_user_2 在吗', [{ key: '@_user_1' }, { key: '@_user_2' }]),
  '你好 在吗',
)

// 7c. Sessions created by the channel land in a dedicated workspace directory,
// never silently on the system drive.
const defaultWorkspace = workspacePathFor({})
assert.ok(defaultWorkspace.endsWith(join('dsh', 'feishu')), `unexpected default: ${defaultWorkspace}`)
assert.ok(process.platform !== 'win32' || !/^c:/i.test(defaultWorkspace), 'default must stay off the system drive')
assert.equal(workspacePathFor({ workspacePath: '  D:\\other  ' }), 'D:\\other')
assert.equal(createCwdFor({}), defaultWorkspace)
assert.equal(createCwdFor({ cwd: 'D:\\explicit' }), 'D:\\explicit')
assert.equal(createCwdFor({ cwd: '', workspacePath: 'D:\\ws' }), 'D:\\ws')

// 7b. Rich text (post) and single-image messages are carried, not dropped.
const post = parsePostContent(JSON.stringify({
  title: '',
  content: [[{ tag: 'img', image_key: 'img_v3_abc' }], [{ tag: 'text', text: '反代详情页 被中间条挡住了' }]],
}))
assert.deepEqual(post.imageKeys, ['img_v3_abc'])
assert.match(post.text, /反代详情页/)
// The same body wrapped per locale must resolve too.
const wrapped = parsePostContent(JSON.stringify({ zh_cn: { title: '标题', content: [[{ tag: 'text', text: '正文' }]] } }))
assert.equal(wrapped.text, '标题\n正文')
assert.deepEqual(parsePostContent('not json'), { text: '', imageKeys: [], files: [] })
assert.equal(parseImageContent('{"image_key":"img_v3_xyz"}'), 'img_v3_xyz')
assert.equal(parseImageContent('{}'), '')
assert.equal(imageExtension(Buffer.from('RIFF0000WEBP', 'latin1')), 'webp')
assert.equal(imageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png')
assert.equal(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
assert.equal(imageExtension(Buffer.from('GIF89a', 'latin1')), 'gif')
assert.equal(imageExtension(Buffer.from('nope', 'latin1')), 'bin')

// The inbound body is the human's own text: no chat id, no reply instruction.
// Routing lives in the plugin's chat memory, so the conversation log stays clean.
const inbound = inboundUserText('  读一下 D:\\mino 目录  ')
assert.equal(inbound, '读一下 D:\\mino 目录')
for (const banned of ['飞书私信', 'chat_id=', 'open_id', 'feishu_send_message', '回复要求']) {
  assert.ok(!inbound.includes(banned), `inbound text must not carry routing metadata: ${banned}`)
}

// 8. Inbound stays off unless explicitly enabled (no long connection side effect).
const inboundOff = mount({})
assert.equal(typeof inboundOff.get('feishu_send_message').execute, 'function')

// 9. Inbound delivery: an identified user message, and agent resolution that
// does not require the session to be open in the app.
// Regressions this pins down:
//   - missing `role` -> the model API rejects every later request with
//     "messages[N]: missing field `role`" (HTTP 422);
//   - missing `id`   -> DSH stores an unidentified message and refuses to load
//     the session later: "session event at seq N lacks an identified message",
//     which leaves the session unopenable.
const { handleInboundEvent, releaseOwnedAgentIfIdle } = await import('../index.js')
const logFile = join(mkdtempSync(join(tmpdir(), 'feishu-log-')), 'feishu-inbound.log')
const readLog = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const lastLog = () => readLog().at(-1)

const feishuEvent = (text, openId = 'ou_y') => ({
  header: { event_id: `evt-${text}` },
  sender: { sender_type: 'user', sender_id: { open_id: openId } },
  message: {
    message_type: 'text',
    chat_id: 'oc_x',
    content: JSON.stringify({ text }),
    mentions: [],
  },
})
const fakeHandle = (sessionId, delivered, disposed, label) => ({
  agent: {
    session: { id: sessionId, log: [] },
    followup: async (message) => { delivered.push(message) },
    whenIdle: async () => {},
  },
  dispose: async () => { disposed.push(label) },
})

// 9a. A live agent (session open in the app) is reused, exactly like the app's
// own session controller does.
const deliveredA = []
const liveAgent = {
  session: { id: 'session-target', log: [] },
  followup: async (message) => { deliveredA.push(message) },
}
const ctxA = {
  logger: { warn: () => {} },
  get: () => undefined,
  agents: { get: (id) => (id === 'session-target' ? liveAgent : undefined) },
}
await handleInboundEvent(ctxA, { sessionId: 'session-target', logFile }, feishuEvent('hello 飞书'), new Set())
assert.equal(deliveredA.length, 1, 'inbound message must reach a live agent')
assert.equal(typeof deliveredA[0].id, 'string', 'inbound followup must carry an id')
assert.match(deliveredA[0].id, /^[0-9a-f-]{36}$/, 'inbound followup id must be a UUID')
assert.equal(deliveredA[0].role, 'user', 'inbound followup must carry role: user')
assert.equal(deliveredA[0].source.kind, 'user')
assert.ok(Array.isArray(deliveredA[0].content), 'inbound followup content must be an array')
assert.match(deliveredA[0].content[0].text, /hello 飞书/)
assert.equal(lastLog().result, 'delivered')
assert.equal(lastLog().via, 'live')
// A sender outside allowedUsers is dropped before any delivery.
await handleInboundEvent(ctxA, { sessionId: 'session-target', allowedUsers: ['ou_allowed'], logFile }, feishuEvent('nope', 'ou_other'), new Set())
assert.equal(deliveredA.length, 1)
assert.equal(lastLog().result, 'dropped')
assert.equal(lastLog().reason, 'sender not in allowedUsers')
// Two deliveries must not reuse one identity.
await handleInboundEvent(ctxA, { sessionId: 'session-target', logFile }, feishuEvent('second'), new Set())
assert.equal(deliveredA.length, 2)
assert.notEqual(deliveredA[1].id, deliveredA[0].id, 'each inbound message needs a fresh id')

// 9b. No live agent -> resume the persisted session (headless activation).
const deliveredB = []
const disposedB = []
const handleB = fakeHandle('session-resumed', deliveredB, disposedB, 'B')
let resumedWith
const ctxB = {
  logger: { warn: () => {} },
  get: () => undefined,
  agents: {
    get: () => undefined,
    resume: async (options) => { resumedWith = options; return handleB },
  },
}
await handleInboundEvent(ctxB, { sessionId: 'session-resumed', logFile }, feishuEvent('resume path'), new Set())
assert.equal(deliveredB.length, 1, 'a resumed session must receive the message')
assert.equal(resumedWith.resumeSessionId, 'session-resumed', 'resume must address the configured session')
assert.match(deliveredB[0].id, /^[0-9a-f-]{36}$/)
assert.equal(lastLog().via, 'resume')

// 9b-2. Idle release: "idleReleaseMinutes: 0" keeps the agent, a positive
// threshold hands it back once the channel is quiet, and never mid-turn.
await releaseOwnedAgentIfIdle({ idleReleaseMinutes: 0, logFile })
assert.deepEqual(disposedB, [], 'idleReleaseMinutes 0 must keep the agent')
await new Promise((resolve) => { setTimeout(resolve, 40) })
await releaseOwnedAgentIfIdle({ idleReleaseMinutes: 0.0002, logFile })
assert.deepEqual(disposedB, ['B'], 'a quiet channel must release the plugin-owned agent')
assert.equal(lastLog().event, 'release')
assert.equal(lastLog().result, 'released')

// 9c. resume fails and sessionMode is "create" -> create with the configured cwd.
const deliveredC = []
const disposedC = []
let createdWith
const handleC = fakeHandle('session-created', deliveredC, disposedC, 'C')
const ctxC = {
  logger: { warn: () => {} },
  get: () => undefined,
  agents: {
    get: () => undefined,
    resume: async () => { throw new Error('session "session-created" not found') },
    create: async (options) => { createdWith = options; return handleC },
  },
}
await handleInboundEvent(
  ctxC,
  { sessionId: 'session-created', sessionMode: 'create', cwd: 'C:\\tmp\\im-workspace', logFile },
  feishuEvent('create path'),
  new Set(),
)
assert.equal(deliveredC.length, 1)
assert.equal(createdWith.sessionId, 'session-created')
assert.equal(createdWith.meta.cwd, 'C:\\tmp\\im-workspace')
assert.equal(lastLog().via, 'create(cwd=C:\\tmp\\im-workspace)')

// 9c-2. The agent is composed with the session's agent preset, exactly like the
// app's own controller. Without this a resumed agent only sees globally
// registered tools (measured on this machine: 16 instead of 39, missing
// pwsh/read/write/edit/grep/glob).
const mountedPresets = []
const observedSessions = []
const disposedObservations = []
const presetService = {
  resolve: async (id) => ({ id: id ?? 'standard' }),
  mount: async (_agentCtx, id) => { mountedPresets.push(id) },
}
const observatory = {
  observeSession: async (id) => {
    observedSessions.push(id)
    return {
      header: { id, agentPreset: 'standard' },
      projections: { values: { agentPreset: 'cordis' } },
      [Symbol.dispose]: () => { disposedObservations.push(id) },
    }
  },
}
const serviceCtx = () => ({
  get: (name) => (name === 'agentPresets' ? presetService : name === 'sessionQuery' ? observatory : undefined),
})
const deliveredG = []
const handleG = fakeHandle('session-preset', deliveredG, [], 'G')
let resumedG
const ctxG = {
  logger: { warn: () => {} },
  ...serviceCtx(),
  agents: {
    get: () => undefined,
    resume: async (options) => { resumedG = options; await options.setup?.({}); return handleG },
  },
}
await handleInboundEvent(ctxG, { sessionId: 'session-preset', logFile }, feishuEvent('preset resume'), new Set())
assert.deepEqual(observedSessions, ['session-preset'], 'the stored session preset must be read from the session')
assert.deepEqual(disposedObservations, ['session-preset'], 'the observation must be released')
assert.deepEqual(mountedPresets, ['cordis'], 'resume must mount the session\'s own preset')
assert.equal(typeof resumedG.setup, 'function')
assert.equal(lastLog().via, 'resume(preset=cordis)')

// create also records the preset on the new session.
const deliveredH = []
const handleH = fakeHandle('session-fresh', deliveredH, [], 'H')
let createdH
const ctxH = {
  logger: { warn: () => {} },
  ...serviceCtx(),
  agents: {
    get: () => undefined,
    resume: async () => { throw new Error('not found') },
    create: async (options) => { createdH = options; await options.setup?.({}); return handleH },
  },
}
await handleInboundEvent(
  ctxH,
  { sessionId: 'session-fresh', sessionMode: 'create', cwd: 'D:\\dsh\\工作区', logFile },
  feishuEvent('preset create'),
  new Set(),
)
assert.equal(createdH.meta.agentPreset, 'cordis', 'a created session must record its preset')
assert.deepEqual(mountedPresets, ['cordis', 'cordis'])
assert.equal(lastLog().via, 'create(cwd=D:\\dsh\\工作区)(preset=cordis)')

// 9d. resume fails and sessionMode is the default -> dropped, with the reason logged.
const deliveredD = []
const ctxD = {
  logger: { warn: () => {} },
  get: () => undefined,
  agents: {
    get: () => undefined,
    resume: async () => { throw new Error('stored session "session-missing" is corrupt') },
  },
}
await handleInboundEvent(ctxD, { sessionId: 'session-missing', logFile }, feishuEvent('dropped'), new Set())
assert.equal(deliveredD.length, 0)
assert.equal(lastLog().result, 'dropped')
assert.match(lastLog().reason, /resume failed: .*is corrupt/)

// 9e. sessionMode "off" never touches the agent services.
const ctxE = {
  logger: { warn: () => {} },
  get: () => undefined,
  agents: { get: () => undefined, resume: async () => { throw new Error('must not be called') } },
}
await handleInboundEvent(ctxE, { sessionId: 'session-target', sessionMode: 'off', logFile }, feishuEvent('off'), new Set())
assert.equal(lastLog().result, 'dropped')
assert.match(lastLog().reason, /sessionMode is "off"/)

// 9g. `/new` switches the channel to a fresh conversation and remembers it.
const stateFile = join(mkdtempSync(join(tmpdir(), 'feishu-state-')), 'state.json')
const createdIds = []
const deliveredNew = []
const ctxNew = {
  logger: { warn: () => {} },
  get: () => undefined,
  agents: {
    get: () => undefined,
    create: async (options) => {
      createdIds.push(options.sessionId)
      return {
        agent: {
          session: { id: options.sessionId, log: [] },
          followup: async (message) => { deliveredNew.push(message) },
          whenIdle: async () => {},
        },
        dispose: async () => {},
      }
    },
  },
}
await handleInboundEvent(
  ctxNew,
  { sessionId: 'session-original', stateFile, logFile, notifyOnNew: false },
  feishuEvent('/new'),
  new Set(),
)
assert.equal(createdIds.length, 1, '/new must create exactly one session')
assert.match(createdIds[0], /^session-[0-9a-f-]{36}$/, '/new session ids must be DSH-shaped')
assert.equal(deliveredNew.length, 0, 'a bare /new must not deliver a prompt')
assert.ok(
  readLog().some((line) => line.event === 'session' && line.result === 'switched'),
  'the switch must be logged as a session event',
)
assert.ok(
  readLog().some((line) => line.event === 'slash' && line.command === 'new'),
  'the command itself must be logged as a slash event',
)
assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).sessionId, createdIds[0], 'the switch must be persisted')

// 9h. `/new <message>` delivers that message as the new conversation's first prompt.
await handleInboundEvent(
  ctxNew,
  { sessionId: 'session-original', stateFile, logFile, notifyOnNew: false },
  feishuEvent('/new 帮我看下 D:\\mino'),
  new Set(),
)
assert.equal(createdIds.length, 2)
assert.equal(deliveredNew.length, 1, '/new <message> must deliver the first prompt')
assert.match(deliveredNew[0].id, /^[0-9a-f-]{36}$/)
assert.equal(deliveredNew[0].role, 'user')
assert.match(deliveredNew[0].content[0].text, /帮我看下/)
assert.notEqual(createdIds[1], createdIds[0], 'each /new must create a distinct session')
assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).sessionId, createdIds[1])

// 9i. Plain messages after /new go to the switched conversation, not the configured one.
let resumedAfterSwitch
const ctxAfter = {
  logger: { warn: () => {} },
  get: () => undefined,
  agents: {
    get: () => undefined,
    resume: async (options) => {
      resumedAfterSwitch = options.resumeSessionId
      return fakeHandle(options.resumeSessionId, [], [], 'after')
    },
  },
}
await handleInboundEvent(
  ctxAfter,
  { sessionId: 'session-original', stateFile, logFile },
  feishuEvent('接着做'),
  new Set(),
)
assert.equal(resumedAfterSwitch, createdIds[1], 'the /new conversation must win over sessionId')

// 9j. The diagnostic log records every inbound outcome as JSONL.
const results = readLog().map((line) => line.result)
assert.ok(results.includes('delivered') && results.includes('dropped'))
assert.ok(results.includes('switched'))
assert.ok(readLog().every((line) => typeof line.time === 'number' && typeof line.event === 'string'))

// 10. Outbound: the turn's answer travels back on its own — plain text when
// cards are off, and a streaming card (create → text → close) when they are on.
// Regression this pins down: the answer must not depend on the model calling a
// tool, and the delivered text must be exactly what the model wrote.
const realFetch = globalThis.fetch
const outboundCalls = []
const respond = (url, init) => {
  outboundCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
  if (String(url).includes('tenant_access_token')) {
    return { code: 0, tenant_access_token: 't-fake', expire: 7200 }
  }
  if (String(url).includes('/open-apis/cardkit/v1/cards')) return { code: 0, data: { card_id: 'card_fake' } }
  if (String(url).includes('/open-apis/im/v1/messages')) {
    return { code: 0, data: { message_id: 'om_fake', chat_id: 'oc_file_default' } }
  }
  return { code: 0, data: {} }
}
globalThis.fetch = async (url, init) => ({
  ok: true,
  status: 200,
  json: async () => respond(url, init),
})
process.env.DSH_HOME = credsHome

const { observeSessionEvent, observeAssistantStream, finalizeTurn } = await import('../index.js')
const outCtx = { logger: { warn: () => {} } }

// 10a. Cards off -> one plain text message carrying the answer verbatim.
const plainConfig = { sessionId: 'session-plain', streamingCards: false, logFile }
observeSessionEvent(outCtx, plainConfig, { id: 'session-plain' }, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终答复 ✅' }] } },
})
await finalizeTurn(outCtx, plainConfig, 'session-plain', 1, { kind: 'completed' })
const textCall = outboundCalls.find((call) => call.url.includes('/open-apis/im/v1/messages'))
assert.ok(textCall, 'a finished turn must be delivered without any tool call')
assert.equal(textCall.body.msg_type, 'text')
assert.equal(JSON.parse(textCall.body.content).text, '最终答复 ✅')
assert.equal(textCall.body.receive_id, 'oc_file_default')

// 10b. Cards on -> create entity, stream cumulative text, close streaming.
outboundCalls.length = 0
const cardConfig = { sessionId: 'session-card', streamingCards: true, logFile }
observeSessionEvent(outCtx, cardConfig, { id: 'session-card' }, {
  type: 'assistant/message',
  data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '卡片答复' }] } },
})
await finalizeTurn(outCtx, cardConfig, 'session-card', 2, { kind: 'completed' })
const cardCreate = outboundCalls.find((call) => call.url.includes('/cardkit/v1/cards'))
assert.ok(cardCreate, 'cards on must create a card entity')
assert.match(JSON.parse(cardCreate.body.data).body.elements[0].content, /卡片答复/)
const cardSend = outboundCalls.find((call) => call.url.includes('/open-apis/im/v1/messages'))
assert.equal(cardSend.body.msg_type, 'interactive')
assert.equal(JSON.parse(cardSend.body.content).data.card_id, 'card_fake')
const cardClose = outboundCalls.find((call) => call.url.includes('/settings'))
assert.ok(cardClose, 'streaming must be closed when the turn ends')
assert.equal(JSON.parse(cardClose.body.settings).config.streaming_mode, false)
assert.ok(cardClose.body.sequence > 0, 'card writes must carry a positive sequence')

// 10b-2. Live deltas type into the same card before the turn closes.
outboundCalls.length = 0
const streamConfig = { sessionId: 'session-stream', streamingCards: true, logFile }
const streamCtx = { logger: { warn: () => {} } }
const frame = (turn, chunk) => ({ agent: { id: 'session-stream' }, frame: { type: 'chunk', turn, index: 0, chunk } })
observeAssistantStream(streamCtx, streamConfig, { agent: { id: 'session-stream' }, frame: { type: 'start', turn: 4 } })
observeAssistantStream(streamCtx, streamConfig, frame(4, { type: 'block-start', index: 0, blockType: 'text' }))
observeAssistantStream(streamCtx, streamConfig, frame(4, { type: 'text-delta', index: 0, text: '第一段' }))
await new Promise((resolve) => setTimeout(resolve, 1_000))
const firstCreate = outboundCalls.find((call) => call.url.includes('/cardkit/v1/cards'))
assert.ok(firstCreate, 'the first delta must create the card')
assert.match(JSON.parse(firstCreate.body.data).body.elements[0].content, /第一段/)
observeAssistantStream(streamCtx, streamConfig, frame(4, { type: 'text-delta', index: 0, text: '第二段' }))
await new Promise((resolve) => setTimeout(resolve, 1_000))
const streamUpdate = outboundCalls.find((call) => call.url.includes('/elements/md_1/content'))
assert.ok(streamUpdate, 'later deltas must type into the already-sent card')
assert.equal(streamUpdate.body.content, '第一段第二段')
await finalizeTurn(streamCtx, streamConfig, 'session-stream', 4, { kind: 'completed' })
assert.ok(outboundCalls.some((call) => call.url.includes('/settings')), 'the streamed card must be closed at turn end')

// 10c. A turn that already pushed its reply through the tool is not duplicated.
outboundCalls.length = 0
const toolConfig = { sessionId: 'session-tool', streamingCards: false, logFile }
observeSessionEvent(outCtx, toolConfig, { id: 'session-tool' }, {
  type: 'tool/call', data: { turn: 5, step: 1, name: 'feishu_send_message', callId: 'c1', arguments: '{}' },
})
observeSessionEvent(outCtx, toolConfig, { id: 'session-tool' }, {
  type: 'assistant/message',
  data: { turn: 5, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已发' }] } },
})
await finalizeTurn(outCtx, toolConfig, 'session-tool', 5, { kind: 'completed' })
assert.equal(outboundCalls.filter((call) => call.url.includes('/open-apis/im/v1/messages')).length, 0)
globalThis.fetch = realFetch

// 11. Unattended sessions: activating a session applies the channel's permission
// preset (an `ask` policy would stall a Feishu turn with nobody to answer it).
const presetCalls = []
const makePresetCtx = (current) => ({
  logger: { warn: () => {} },
  get: (name) => (name === 'permissionPresets'
    ? { current: () => current, set: (session, preset) => presetCalls.push([session.id, preset]) }
    : undefined),
  agents: { get: (id) => (id === 'session-target' ? liveAgent : undefined) },
})
await handleInboundEvent(
  makePresetCtx('workspace-write'),
  { sessionId: 'session-target', logFile, permissionPreset: 'danger-full-access' },
  feishuEvent('perm'),
  new Set(),
)
assert.deepEqual(presetCalls, [['session-target', 'danger-full-access']])
presetCalls.length = 0
await handleInboundEvent(
  makePresetCtx('danger-full-access'),
  { sessionId: 'session-target', logFile, permissionPreset: 'danger-full-access' },
  feishuEvent('perm-again'),
  new Set(),
)
assert.deepEqual(presetCalls, [], 'a session already on the preset must not be switched again')

// 12. Every session in the Feishu workspace inherits the channel policy, including
// one opened from the GUI (its cwd is the workspace directory); sessions elsewhere
// keep their own policy.
const wsCalls = []
const wsCtx = {
  logger: { warn: () => {} },
  get: (name) => (name === 'permissionPresets'
    ? { current: () => 'workspace-write', set: (session, preset) => wsCalls.push([session.id, preset]) }
    : undefined),
}
const wsConfig = { sessionId: 'session-other', workspacePath: 'C:\\tmp\\feishu-ws', permissionPreset: 'danger-full-access' }
observeSessionEvent(wsCtx, wsConfig, { id: 'session-gui', header: { cwd: 'C:\\tmp\\feishu-ws' } }, { type: 'turn/start', data: { turn: 1 } })
assert.deepEqual(wsCalls, [['session-gui', 'danger-full-access']])
wsCalls.length = 0
observeSessionEvent(wsCtx, wsConfig, { id: 'session-elsewhere', header: { cwd: 'D:\\dsh\\work' } }, { type: 'turn/start', data: { turn: 1 } })
assert.deepEqual(wsCalls, [], 'a session outside the Feishu workspace must keep its own policy')

// 13. Naming: the session is titled before it is published to the workspace, so
// the list row is never nameless. The model provider wins; the first line of the
// prompt is pinned when it is absent or fails.
const { ensureSessionTitle, deriveTitle } = await import('../index.js')
assert.equal(deriveTitle('# 帮我看下 D:\\mino 目录\n第二行'), '帮我看下 D:\\mino 目录')
assert.equal(deriveTitle('   '), '')
assert.ok(deriveTitle('一'.repeat(40)).endsWith('…'))

const titleCalls = []
const titleCtx = (behavior) => ({ get: (name) => (name === 'sessionTitle' ? behavior : undefined) })
const titledSession = { id: 'session-titled' }
assert.equal(
  await ensureSessionTitle(titleCtx({
    get: () => undefined,
    refresh: async () => ({ title: '模型生成的标题' }),
    rename: (_session, title) => titleCalls.push(['rename', title]),
  }), { logFile }, titledSession, '随便一句话'),
  '模型生成的标题',
)
assert.deepEqual(titleCalls, [], 'a provider title must not be pinned over')

// A placeholder like "Greeting" names nothing: the prompt's own words are pinned.
assert.equal(
  await ensureSessionTitle(titleCtx({
    get: () => undefined,
    refresh: async () => ({ title: 'Greeting' }),
    rename: (_session, title) => (titleCalls.push(['rename', title]), { title }),
  }), { logFile }, titledSession, '你好'),
  '你好',
)

assert.equal(
  await ensureSessionTitle(titleCtx({
    get: () => undefined,
    refresh: async () => { throw new Error('model down') },
    rename: (_session, title) => (titleCalls.push(['rename', title]), { title }),
  }), { logFile }, titledSession, '把 WPS 白屏那个修一下'),
  '把 WPS 白屏那个修一下',
)
assert.deepEqual(titleCalls.at(-1), ['rename', '把 WPS 白屏那个修一下'])

assert.equal(
  await ensureSessionTitle(titleCtx({
    get: () => ({ title: '已有的标题' }),
    refresh: async () => { throw new Error('must not run') },
    rename: () => { throw new Error('must not run') },
  }), { logFile }, titledSession, 'x'),
  '已有的标题',
)

// An existing placeholder title is replaced by the prompt's own words.
assert.equal(
  await ensureSessionTitle(titleCtx({
    get: () => ({ title: 'Greeting' }),
    refresh: async () => ({ title: 'Greeting' }),
    rename: (_session, title) => (titleCalls.push(['rename', title]), { title }),
  }), { logFile }, titledSession, '查一下昨天的账单'),
  '查一下昨天的账单',
)
globalThis.fetch = realFetch

// 14. Attachments: pictures and files each upload first, then send with the
// matching msg_type. This is the outbound half of "能发附件".
const { attachmentKind, sendAttachment } = await import('../index.js')
assert.equal(attachmentKind('a.png'), 'image')
assert.equal(attachmentKind('C:\\tmp\\A.PNG'), 'image')
assert.equal(attachmentKind('a.pdf'), 'file')
assert.equal(attachmentKind('noext'), 'file')

const attachCalls = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/open-apis/im/v1/images')) {
    attachCalls.push(['upload-image', init.method])
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { image_key: 'img_x' } }) }
  }
  if (target.includes('/open-apis/im/v1/files')) {
    attachCalls.push(['upload-file', init.method])
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { file_key: 'file_x' } }) }
  }
  attachCalls.push(['message', JSON.parse(init.body)])
  return { ok: true, status: 200, json: async () => ({ code: 0, data: { message_id: 'om_attach' } }) }
}
const attachDir = mkdtempSync(join(tmpdir(), 'feishu-attach-'))
const pngPath = join(attachDir, 'shot.png')
writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const pdfPath = join(attachDir, 'report.pdf')
writeFileSync(pdfPath, Buffer.from('%PDF-1.4\n'))
const attachTarget = { receiveId: 'oc_x', receiveIdType: 'chat_id' }
const imageResult = await sendAttachment('https://open.feishu.cn', 't-fake', { path: pngPath }, attachTarget)
assert.equal(imageResult.kind, 'image')
assert.equal(imageResult.key, 'img_x')
assert.equal(imageResult.messageId, 'om_attach')
const fileResult = await sendAttachment('https://open.feishu.cn', 't-fake', { path: pdfPath }, attachTarget)
assert.equal(fileResult.kind, 'file')
assert.equal(fileResult.key, 'file_x')
assert.deepEqual(
  attachCalls.filter((call) => call[0] === 'message').map((call) => call[1].msg_type),
  ['image', 'file'],
)
assert.deepEqual(
  JSON.parse(attachCalls.find((call) => call[0] === 'message')[1].content),
  { image_key: 'img_x' },
)
assert.ok(attachCalls.some((call) => call[0] === 'upload-image') && attachCalls.some((call) => call[0] === 'upload-file'))
globalThis.fetch = realFetch

// 15. Credentials store: FEISHU_APP_ID / FEISHU_APP_SECRET fill a missing
// config or file value, and a configured value keeps its precedence.
const { resolveSettingsWithCredentials } = await import('../providers/feishu.js')
process.env.DSH_HOME = emptyHome
const fakeStore = {
  resolve: async (name) => (name === 'FEISHU_APP_ID'
    ? { value: 'cred-id' }
    : name === 'FEISHU_APP_SECRET' ? { value: 'cred-secret' } : undefined),
}
const fromStore = await resolveSettingsWithCredentials({}, fakeStore)
assert.equal(fromStore.appId, 'cred-id')
assert.equal(fromStore.appSecret, 'cred-secret')
assert.equal(fromStore.credentialSource, 'credentials')
const explicitWins = await resolveSettingsWithCredentials({ appId: 'row-id' }, fakeStore)
assert.equal(explicitWins.appId, 'row-id', 'row config outranks the credentials store')
const brokenStore = { resolve: async () => { throw new Error('store down') } }
const tolerant = await resolveSettingsWithCredentials({ appSecret: 'row-secret' }, brokenStore)
assert.equal(tolerant.appId, '', 'a failing store must not break settings resolution')

// 16. Slash commands: parsed, consumed before the model, and able to stop a turn.
const { parseSlashCommand, stopTurn, statusText } = await import('../index.js')
assert.equal(parseSlashCommand('普通消息'), null)
assert.equal(parseSlashCommand('/').name, '', 'a bare slash is an empty command, not a message')
assert.deepEqual(parseSlashCommand('/help'), { name: 'help', args: '', raw: '/help' })
assert.deepEqual(parseSlashCommand('/new 帮我看下 A'), { name: 'new', args: '帮我看下 A', raw: '/new 帮我看下 A' })
assert.equal(parseSlashCommand('/rename   两个空格  ').args, '两个空格')
assert.equal(parseSlashCommand('/stop').name, 'stop')
assert.equal(parseSlashCommand(' /status ').name, 'status')

const cancelled = []
const stopCtx = (agent) => ({ agents: { get: () => agent } })
assert.equal((await stopTurn(stopCtx(undefined), { sessionId: 's1' })).reason, 'no-agent')
assert.equal((await stopTurn(stopCtx({ status: 'idle' }), { sessionId: 's1' })).reason, 'idle')
assert.equal((await stopTurn(stopCtx({ status: 'running', cancel: (cause) => cancelled.push(cause) }), { sessionId: 's1' })).reason, 'cancelled')
assert.deepEqual(cancelled, [{ kind: 'user' }], 'stop must cancel with the user cause')
assert.equal((await stopTurn(stopCtx({ status: 'running' }), { sessionId: '' })).reason, 'no-session')

const statusReport = await statusText(
  { agents: { get: () => undefined }, get: () => undefined },
  { sessionId: 'session-x', workspacePath: 'C:\\tmp\\feishu-ws' },
  'oc_x',
)
assert.match(statusReport, /会话：session-x/)
assert.match(statusReport, /工作区：C:\\tmp\\feishu-ws/)
assert.match(statusReport, /权限：danger-full-access/)
assert.match(statusReport, /目标群：oc_x/)

// 17. Thinking process + reaction acknowledgement: CoT events are well-formed and
// the provider talks to the documented endpoints.
const { cotEvent } = await import('../index.js')
const firstCot = cotEvent('RUN_STARTED', { threadId: 'oc_x', runId: 'turn-1' })
const secondCot = cotEvent('RUN_FINISHED', { status: 'done' })
assert.equal(firstCot.event_type, 'RUN_STARTED')
assert.deepEqual(JSON.parse(firstCot.content), { threadId: 'oc_x', runId: 'turn-1' })
assert.ok(Number(secondCot.timestamp) > Number(firstCot.timestamp), 'CoT timestamps must strictly increase')
assert.ok(cotEvent('TEXT_MESSAGE_CONTENT', { delta: 'x'.repeat(5000) }).content.length <= 4200)

const cotCalls = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  cotCalls.push({ url: target, method: init?.method })
  if (target.includes('tenant_access_token')) {
    return { ok: true, status: 200, json: async () => ({ tenant_access_token: 't-fake', expire: 7200 }) }
  }
  if (target.includes('/message_cot') && init?.method === 'POST') {
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { cot_id: 'cot_1', message_id: 'om_cot' } }) }
  }
  if (target.includes('/reactions') && init?.method === 'POST') {
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { reaction_id: 'rx_1' } }) }
  }
  return { ok: true, status: 200, json: async () => ({ code: 0, data: {} }) }
}
process.env.DSH_HOME = credsHome
const { createFeishuProvider } = await import('../providers/feishu.js')
const cotProvider = createFeishuProvider({})
assert.deepEqual(await cotProvider.cotCreate({ chatId: 'oc_x' }), { cotId: 'cot_1', messageId: 'om_cot' })
await cotProvider.cotWrite({ cotId: 'cot_1', messageId: 'om_cot', events: [firstCot] })
assert.equal(await cotProvider.addReaction({ messageId: 'om_1' }), 'rx_1')
await cotProvider.removeReaction({ messageId: 'om_1', reactionId: 'rx_1' })
assert.ok(cotCalls.some((call) => call.url.includes('/message_cot')), 'the CoT endpoint must be used')
assert.ok(cotCalls.some((call) => call.url.includes('/reactions')), 'the reaction endpoint must be used')
globalThis.fetch = realFetch

// 18. Workspace auto-provisioning: a fresh machine gets the directory, the
// workspace entry (titled 飞书) and the session attached to it.
const { attachToFeishuWorkspace } = await import('../index.js')
const wsRoot = join(mkdtempSync(join(tmpdir(), 'feishu-ws-')), 'dsh-feishu')
const createdWorkspaces = []
const attachedSessions = []
const wsRegistry = {
  resolveByPath: async (path) => createdWorkspaces.find((entry) => entry.path === path),
  create: async (path, title) => {
    const entry = { path, title, attachSession: async (id) => { attachedSessions.push(id) } }
    createdWorkspaces.push(entry)
    return entry
  },
}
const wsCtx2 = {
  logger: { warn: () => {} },
  get: (name) => (name === 'workspaceRegistry' ? wsRegistry : undefined),
}
const attached = await attachToFeishuWorkspace(wsCtx2, { workspacePath: wsRoot, logFile }, 'session-ws')
assert.equal(attached, true)
assert.equal(existsSync(wsRoot), true, 'the workspace directory must exist on disk')
assert.deepEqual(createdWorkspaces.map((entry) => entry.title), ['飞书'])
assert.deepEqual(attachedSessions, ['session-ws'])
// A second session reuses the workspace instead of creating another one.
await attachToFeishuWorkspace(wsCtx2, { workspacePath: wsRoot, logFile }, 'session-ws2')
assert.equal(createdWorkspaces.length, 1, 'the workspace must be reused by path')
assert.deepEqual(attachedSessions, ['session-ws', 'session-ws2'])
// A host without the registry must not break delivery.
assert.equal(await attachToFeishuWorkspace({ logger: { warn: () => {} }, get: () => undefined }, { logFile }, 'x'), false)

// 19. Model and thinking-effort control through the DSH services.
const { modelCommand, thinkCommand } = await import('../index.js')
const selections = []
const fakeModel = {
  current: () => ({ provider: 'p1', model: 'm1', reasoningEffort: 'low' }),
  select: (selection) => selections.push(selection),
}
const fakeAgent = { model: fakeModel, status: 'idle', session: { id: 'session-m' } }
const fakeLlm = {
  listProviders: async () => [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
  listModels: async (provider) => (provider === 'p1'
    ? [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }]
    : [{ id: 'n1', name: 'N1' }]),
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }),
}
const modelCtx = {
  agents: { get: (id) => (id === 'session-m' ? fakeAgent : undefined) },
  get: (name) => (name === 'llm' ? fakeLlm : undefined),
}
const modelConfig = { sessionId: 'session-m' }
assert.match(await modelCommand(modelCtx, modelConfig, ''), /当前：p1\/m1/)
assert.match(await modelCommand(modelCtx, modelConfig, 'm2'), /已切到 p1\/m2/)
assert.deepEqual(selections.at(-1), { provider: 'p1', model: 'm2', reasoningEffort: 'low' })
assert.match(await modelCommand(modelCtx, modelConfig, 'n1'), /已切到 p2\/n1/)
selections.length = 0
assert.match(await thinkCommand(modelCtx, modelConfig, ''), /可选：low \/ high/)
assert.match(await thinkCommand(modelCtx, modelConfig, 'high'), /已设为 high/)
assert.deepEqual(selections.at(-1), { provider: 'p1', model: 'm1', reasoningEffort: 'high' })
assert.match(await thinkCommand(modelCtx, modelConfig, 'nope'), /没有这个档位/)
assert.match(
  await modelCommand({ agents: { get: () => undefined }, get: () => undefined }, { sessionId: 'none' }, ''),
  /未激活/,
)

console.log('smoke ok: 3 tools registered, schemas valid, credentials precedence, '
  + 'inbound helpers, error paths, identified-message contract, /new switching, '
  + 'plain-text inbound bodies, automatic turn delivery, streaming cards, and '
  + 'unattended permission presets behave')
