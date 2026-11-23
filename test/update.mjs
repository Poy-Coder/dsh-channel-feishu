/**
 * The upgrade notice in `/status`.
 *
 * It exists because DSH can install a newer plugin version but never says one exists:
 * the user has to open Plugin Manager and look. The check is quiet by design — one
 * registry request a day at most, cached, and every failure means "say nothing".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compareVersions, refreshVersionCache, updateNotice } from '../lib/update.js'

const stateFile = () => join(mkdtempSync(join(tmpdir(), 'dsh-update-')), 'update.json')

const okFetch = (version) => async () => ({ ok: true, json: async () => ({ version }) })

test('a notice appears only when the registry has something newer', () => {
  assert.equal(updateNotice({ version: '0.9.39', latest: '0.9.40' }), '新版本：0.9.40 可用（当前 0.9.39）')
  assert.equal(updateNotice({ version: '0.9.40', latest: '0.9.40' }), '', '同版本不提示')
  assert.equal(updateNotice({ version: '0.9.40', latest: '' }), '', '没查到就别说')
  assert.equal(updateNotice({}), '')
})

test('versions compare numerically, not as strings', () => {
  assert.ok(compareVersions('0.9.9', '0.9.10') < 0, '0.9.9 比 0.9.10 旧')
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.ok(compareVersions('1.2.3-rc.1', '1.2.3') < 0, '预发布比正式版旧')
})

test('a fresh check is cached and not repeated the same day', async () => {
  const file = stateFile()
  let calls = 0
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ version: '2.0.0' }) } }

  const first = await refreshVersionCache({ name: 'pkg', version: '1.0.0', stateFile: file, fetchImpl })
  assert.equal(first.latest, '2.0.0')
  assert.equal(calls, 1)

  const second = await refreshVersionCache({ name: 'pkg', version: '1.0.0', stateFile: file, fetchImpl })
  assert.equal(second.latest, '2.0.0', '缓存命中')
  assert.equal(calls, 1, '一天内不应重复请求')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).latest, '2.0.0')
})

test('an old cache is refreshed', async () => {
  const file = stateFile()
  const day = 24 * 60 * 60 * 1000
  let calls = 0
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ version: '3.0.0' }) } }
  await refreshVersionCache({ name: 'pkg', version: '1.0.0', stateFile: file, now: 1_000, fetchImpl })
  await refreshVersionCache({ name: 'pkg', version: '1.0.0', stateFile: file, now: 1_000 + day + 1, fetchImpl })
  assert.equal(calls, 2)
})

test('a failed check says nothing and never throws', async () => {
  const file = stateFile()
  const failing = async () => { throw new Error('offline') }
  const result = await refreshVersionCache({ name: 'pkg', version: '1.0.0', stateFile: file, fetchImpl: failing })
  assert.equal(result.latest, '')

  const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) })
  assert.equal((await refreshVersionCache({ name: 'pkg', version: '1.0.0', stateFile: file, fetchImpl: notFound })).latest, '')

  const garbage = async () => ({ ok: true, json: async () => ({}) })
  assert.equal((await refreshVersionCache({ name: 'pkg', version: '1.0.0', stateFile: file, fetchImpl: garbage })).latest, '')
})

test('a missing name or path is not an error', async () => {
  assert.equal((await refreshVersionCache({})).latest, '')
  assert.equal((await refreshVersionCache({ name: 'pkg' })).latest, '')
})

test('one good fetch is enough for the notice', async () => {
  const file = stateFile()
  const info = await refreshVersionCache({
    name: 'pkg', version: '0.9.39', stateFile: file, fetchImpl: okFetch('0.9.41'),
  })
  assert.equal(updateNotice(info), '新版本：0.9.41 可用（当前 0.9.39）')
})
