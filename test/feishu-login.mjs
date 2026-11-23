/**
 * The scan-to-create flow's payload.
 *
 * Getting `addons` wrong is invisible until a user scans and the created app is missing
 * a permission — the failure then looks like "the plugin is broken", not "the setup
 * omitted a scope". So the payload is asserted here, decompressed exactly as the
 * platform would read it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'

import { REQUIRED_EVENTS, REQUIRED_SCOPES, encodeAddons } from '../scripts/feishu-login.mjs'

const decode = (packed) => JSON.parse(gunzipSync(Buffer.from(packed, 'base64url')).toString('utf8'))

test('the payload decompresses to the shape the registration endpoint expects', () => {
  const decoded = decode(encodeAddons())
  assert.deepEqual(decoded.scopes.tenant, [...REQUIRED_SCOPES])
  assert.deepEqual(decoded.events.items.tenant, [...REQUIRED_EVENTS])
})

test('every scope the plugin actually uses is present', () => {
  // 每个 scope 对应一个真实调用：读消息、发消息+CoT、附件、卡片、表情
  for (const scope of [
    'im:message.p2p_msg:readonly',
    'im:message:send_as_bot',
    'im:resource',
    'cardkit:card:write',
    'im:message.react',
  ]) {
    assert.ok(REQUIRED_SCOPES.includes(scope), `缺少 ${scope}`)
  }
})

test('card.action.trigger is registered, or the cards are dead buttons', () => {
  // 问答卡/审批卡靠它回传；漏了之后卡片能渲染但点不动
  assert.ok(REQUIRED_EVENTS.includes('card.action.trigger'))
  assert.ok(REQUIRED_EVENTS.includes('im.message.receive_v1'))
})

test('no group scope is requested while group chat is unsupported', () => {
  for (const scope of REQUIRED_SCOPES) {
    assert.doesNotMatch(scope, /group/i, `不支持群聊却申请了 ${scope}`)
  }
})

test('the payload is base64url and survives a round trip', () => {
  const packed = encodeAddons()
  assert.match(packed, /^[A-Za-z0-9_-]+$/, '必须是 base64url，不能带 + / =')
  assert.ok(packed.length > 20)
})

test('overrides let a caller narrow or extend the set', () => {
  const decoded = decode(encodeAddons({ scopes: ['im:resource'], events: ['im.message.receive_v1'] }))
  assert.deepEqual(decoded.scopes.tenant, ['im:resource'])
  assert.deepEqual(decoded.events.items.tenant, ['im.message.receive_v1'])
})
