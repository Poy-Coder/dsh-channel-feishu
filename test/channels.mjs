/**
 * Hermetic tests for the per-channel identity: each channel owns its workspace,
 * state/log files and tool names, so Feishu and WeChat can run side by side.
 *
 * Usage: node test/channels.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'feishu-channels-'))

const {
  channelProfile,
  createCwdFor,
  workspacePathFor,
} = await import('../index.js')

// 1. Known channels resolve to their own identity.
const feishu = channelProfile({})
assert.equal(feishu.id, 'feishu')
assert.equal(feishu.label, '飞书')
assert.equal(feishu.toolPrefix, 'feishu')
assert.equal(feishu.fileSlug, 'feishu')
assert.equal(feishu.workspaceName, 'dsh-feishu')
assert.equal(feishu.sessionPrefix, '飞书会话')

const wechat = channelProfile({ provider: 'wechat' })
assert.equal(wechat.label, '微信')
assert.equal(wechat.toolPrefix, 'wechat')
assert.equal(wechat.workspaceName, 'dsh-wechat')
assert.equal(wechat.sessionPrefix, '微信会话')

// An unknown provider still gets a stable, filesystem-safe identity.
const custom = channelProfile({ provider: 'Ding Talk!' })
assert.equal(custom.id, 'ding talk!')
assert.equal(custom.workspaceName, 'dsh-dingtalk')
assert.equal(custom.toolPrefix, 'dingtalk')
assert.equal(custom.label, 'Ding Talk!')

// 2. Workspaces do not collide unless the row config points both at one path.
const feishuPath = workspacePathFor({})
const wechatPath = workspacePathFor({ provider: 'wechat' })
assert.ok(feishuPath.endsWith(join('dsh', 'feishu')), feishuPath)
assert.ok(wechatPath.endsWith(join('dsh', 'wechat')), wechatPath)
assert.notEqual(feishuPath, wechatPath)
assert.ok(process.platform !== 'win32' || !/^c:/i.test(wechatPath), 'default stays off the system drive')

// 3. An explicit workspacePath still wins for either channel.
assert.equal(workspacePathFor({ provider: 'wechat', workspacePath: 'D:\\wx' }), 'D:\\wx')
assert.equal(wechatPath, createCwdFor({ provider: 'wechat' }))

console.log('channels: all assertions passed')
