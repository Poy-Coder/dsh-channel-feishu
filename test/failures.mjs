/**
 * Hermetic tests for the failure diagnostics: the one-line cause shown on the
 * card, and the runtime marker that lets the next start explain a lost answer.
 *
 * Usage: node test/failures.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'feishu-failures-'))

const { failureTextOf, readRuntimeMarker, writeRuntimeMarker } = await import('../index.js')

// 1. A failed turn reports the message the engine gave.
assert.equal(failureTextOf({ kind: 'error', error: { message: 'tools: disk full' } }), 'tools: disk full')
// A code without a message is still better than "something broke".
assert.equal(failureTextOf({ kind: 'error', error: { code: 'E_NO_ROUTE' } }), '错误码 E_NO_ROUTE')
// Nothing usable: say so instead of an empty note.
assert.equal(failureTextOf({ kind: 'error', error: {} }), '没有给出原因')
// It also accepts a bare reason that carries its own message.
assert.equal(failureTextOf({ kind: 'error', message: 'aborted by user' }), 'aborted by user')
// A long stack-ish message is clipped so the card stays readable.
const long = failureTextOf({ kind: 'error', error: { message: 'x'.repeat(500) } })
assert.equal(long.length, 301)
assert.ok(long.endsWith('…'))
// Normal endings are not failures.
assert.equal(failureTextOf(undefined), '')
assert.equal(failureTextOf({ kind: 'stop' }), '')
assert.equal(failureTextOf({ kind: 'aborted', error: { message: 'stop' } }), '')

// 2. Runtime marker: an in-flight turn is persisted, a clean stop clears it.
assert.equal(writeRuntimeMarker({}, { clean: false, activeTurn: { sessionId: 'session-a', turn: 3, at: 123 } }), true)
const dirty = readRuntimeMarker({})
assert.equal(dirty.clean, false)
assert.equal(dirty.activeTurn.sessionId, 'session-a')
assert.equal(dirty.activeTurn.turn, 3)
// The marker keeps earlier keys when one field is patched.
writeRuntimeMarker({}, { clean: true, stoppedAt: 456, activeTurn: undefined })
const clean = readRuntimeMarker({})
assert.equal(clean.clean, true)
assert.equal(clean.stoppedAt, 456)
assert.equal(clean.activeTurn, undefined, 'a clean stop must drop the in-flight turn')

console.log('failures: all assertions passed')
