/**
 * Hermetic tests for inbound attachments: where they land and how a `file`
 * message is parsed. No network, no DSH.
 *
 * Usage: node test/attachments.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'feishu-attach-'))

const { inboundFilesDir, parseFileContent, parseInboundEvent } = await import('../index.js')

// Attachments live in the channel workspace so the agent can open them by a
// workspace-relative path; an explicit setting still wins.
assert.equal(inboundFilesDir({ workspacePath: 'D:\\ws' }), join('D:\\ws', 'attachments'))
assert.equal(inboundFilesDir({ workspacePath: 'D:\\ws', inboundFilesDir: 'D:\\custom' }), 'D:\\custom')
assert.ok(inboundFilesDir({}).includes('feishu-inbound-files'))

// A file message body is `{ file_key, file_name }`.
assert.deepEqual(parseFileContent('{"file_key":"fk_1","file_name":"季度报告.pdf"}'), {
  fileKey: 'fk_1',
  fileName: '季度报告.pdf',
})
assert.deepEqual(parseFileContent('not json'), { fileKey: '', fileName: '' })

const fileEvent = {
  header: { event_id: 'evt_1' },
  message: {
    message_id: 'om_1',
    chat_id: 'oc_1',
    message_type: 'file',
    content: '{"file_key":"fk_1","file_name":"季度报告.pdf"}',
  },
  sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
}
const parsed = parseInboundEvent(fileEvent)
assert.equal(parsed.unsupported, '')
assert.equal(parsed.messageId, 'om_1')
assert.deepEqual(parsed.files, [{ fileKey: 'fk_1', fileName: '季度报告.pdf' }])
assert.deepEqual(parsed.imageKeys, [])

// Unsupported types still short-circuit.
const sticker = { ...fileEvent, message: { ...fileEvent.message, message_type: 'sticker' } }
assert.equal(parseInboundEvent(sticker).unsupported, 'sticker')

// chat_type travels with the event: group chats are refused by the channel.
const groupEvent = { ...fileEvent, message: { ...fileEvent.message, chat_type: 'group' } }
assert.equal(parseInboundEvent(groupEvent).chatType, 'group')
const p2pEvent = { ...fileEvent, message: { ...fileEvent.message, chat_type: 'p2p' } }
assert.equal(parseInboundEvent(p2pEvent).chatType, 'p2p')

console.log('attachments: all assertions passed')
