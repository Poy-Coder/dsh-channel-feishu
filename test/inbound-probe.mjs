/**
 * Standalone Feishu long-connection probe (diagnostic, not part of the plugin).
 *
 * Subscribes to im.message.receive_v1 and appends every received event to a log
 * file. Proves that the Feishu app's event subscription and permissions really
 * deliver messages, independently of the DSH plugin and without a restart.
 *
 * Usage: node test/inbound-probe.mjs [runMinutes]
 */
import { appendFileSync } from 'node:fs'

const OUT = process.env.FEISHU_PROBE_LOG
  ?? 'D:\\dsh\\工作区\\_tools\\feishu-inbound-probe.log'
// 凭据只从环境变量读，不写死在源码里（源码会进版本库/被分享）。
// 本机可从 ~/.dsh/feishu-channel.json 取 appId/appSecret 后导出。
const APP_ID = process.env.FEISHU_APP_ID ?? ''
const APP_SECRET = process.env.FEISHU_APP_SECRET ?? ''
if (!APP_ID || !APP_SECRET) {
  console.error('missing FEISHU_APP_ID / FEISHU_APP_SECRET (export them before probing)')
  process.exit(2)
}
const RUN_MS = Number(process.argv[2] ?? 20) * 60 * 1000

const mod = await import('@larksuiteoapi/node-sdk')
const Lark = mod?.default?.WSClient ? mod.default : mod

const record = (kind, payload) => {
  const line = `${new Date().toISOString()}\t${kind}\t${JSON.stringify(payload)}`
  appendFileSync(OUT, `${line}\n`)
  console.log(line)
}

const dispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    record('message.receive', {
      chat_id: data?.message?.chat_id,
      chat_type: data?.message?.chat_type,
      message_type: data?.message?.message_type,
      content: data?.message?.content,
      open_id: data?.sender?.sender_id?.open_id,
      sender_type: data?.sender?.sender_type,
      event_id: data?.header?.event_id,
    })
  },
})

const ws = new Lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: Lark.LoggerLevel.info })
record('probe', { state: 'starting', out: OUT })
await ws.start({ eventDispatcher: dispatcher })
record('probe', { state: 'ready', note: 'send a Feishu message to the bot now' })

setTimeout(() => {
  record('probe', { state: 'timeout-exit' })
  try { ws.close() } catch { /* ignore */ }
  process.exit(0)
}, RUN_MS)
