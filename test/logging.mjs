/**
 * Hermetic tests for the diagnostics log levels. No network, no DSH.
 *
 * Usage: node test/logging.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'feishu-log-'))

const { channelLog, logLevelOf } = await import('../index.js')

// Explicit levels win.
assert.equal(logLevelOf({ level: 'debug', result: 'card-update-failed' }), 'debug')

// Failures are errors, even when the result field is terse.
assert.equal(logLevelOf({ event: 'question', result: 'card-update-failed' }), 'error')
assert.equal(logLevelOf({ event: 'card', result: 'close-failed' }), 'error')
assert.equal(logLevelOf({ event: 'question', result: 'card-bad-value' }), 'warn')

// Recoverable conditions are warnings.
assert.equal(logLevelOf({ event: 'card', result: 'rate-limited' }), 'warn')
assert.equal(logLevelOf({ event: 'question', result: 'timeout' }), 'warn')
assert.equal(logLevelOf({ event: 'question', result: 'aborted' }), 'warn')

// Diagnostics are debug, ordinary delivery is info.
assert.equal(logLevelOf({ event: 'debug', result: 'stream-shape' }), 'debug')
assert.equal(logLevelOf({ event: 'inbound', result: 'delivered' }), 'info')
assert.equal(logLevelOf({ event: 'card', result: 'created' }), 'info')
assert.equal(logLevelOf({}), 'info')

// The leveled facade exists and does not throw without a host config.
assert.equal(typeof channelLog.info, 'function')
assert.doesNotThrow(() => channelLog.debug({ logLevel: 'error' }, { event: 'debug', result: 'dropped' }))

console.log('logging: all assertions passed')
