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
// An envelope carries event_id; the SDK hands over the bare body, so dedupe
// falls back to message_id — that is what makes a restart redelivery visible.
assert.equal(parsed.dedupeKey, 'evt_1')
const envelopeLess = { ...fileEvent }
delete envelopeLess.header
assert.equal(parseInboundEvent(envelopeLess).dedupeKey, 'om_1')
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

// A file dragged into the composer arrives as a rich-text (`post`) element, not
// as a `file` message; the post parser must surface it as an attachment.
const postWithFile = {
  header: { event_id: 'evt_2' },
  message: {
    message_id: 'om_2',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'post',
    content: JSON.stringify({
      title: '',
      content: [[
        { tag: 'text', text: '这是那边返回的 md' },
        { tag: 'media', file_key: 'fk_md', file_name: 'error-log.md' },
      ]],
    }),
  },
  sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
}
const parsedPost = parseInboundEvent(postWithFile)
assert.equal(parsedPost.unsupported, '')
assert.equal(parsedPost.text, '这是那边返回的 md')
assert.deepEqual(parsedPost.files, [{ fileKey: 'fk_md', fileName: 'error-log.md' }])
console.log('attachments: all assertions passed')
