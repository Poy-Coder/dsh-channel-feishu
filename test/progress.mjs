/**
 * Hermetic tests for the streaming-card placeholder. No network, no DSH.
 *
 * Usage: node test/progress.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'feishu-progress-'))

const { progressText } = await import('../index.js')

const now = Date.now()

// A fresh turn with nothing running yet: just the placeholder.
const idle = progressText({ startedAt: now, activity: '', toolSteps: 0 }, now)
assert.equal(idle, '思考中…')

// A running tool names itself and counts the calls.
const running = progressText({ startedAt: now - 42_000, activity: 'pwsh', toolSteps: 3 }, now)
assert.match(running, /思考中…/)
assert.match(running, /正在执行 pwsh/)
assert.match(running, /已调用 3 个工具/)
assert.match(running, /已用时 42s/)

// Between tools the activity clears but the counters keep the card alive.
const between = progressText({ startedAt: now - 12_000, activity: '', toolSteps: 2 }, now)
assert.match(between, /已调用 2 个工具/)
assert.match(between, /已用时 12s/)
assert.doesNotMatch(between, /正在执行/)

// Sub-5s turns stay quiet: no distracting elapsed ticker.
const early = progressText({ startedAt: now - 2_000, activity: '', toolSteps: 0 }, now)
assert.equal(early, '思考中…')

console.log('progress: all assertions passed')
