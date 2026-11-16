/**
 * Hermetic tests for the dsh compatibility surface: the semver order the plugin
 * uses to double-check its own `engines.dsh`, and the manifest it reads.
 *
 * Usage: node test/compat.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'feishu-compat-'))

const {
  PLUGIN_MANIFEST,
  compareSemver,
  dshRuntimeVersion,
  parseSemver,
  versionSatisfies,
} = await import('../index.js')

// 1. Parsing: plain, prerelease, build metadata, and junk.
assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
assert.deepEqual(parseSemver('v0.2.2-rc.3'), { major: 0, minor: 2, patch: 2, prerelease: ['rc', '3'] })
assert.deepEqual(parseSemver('0.2.2-rc.3+build.5').prerelease, ['rc', '3'])
assert.equal(parseSemver('0.2'), undefined)
assert.equal(parseSemver(''), undefined)

// 2. Precedence: numbers, then release over prerelease, then identifiers.
assert.equal(compareSemver('0.2.2', '0.2.2'), 0)
assert.equal(compareSemver('0.2.2-rc.3', '0.2.2'), -1)
assert.equal(compareSemver('0.3.0', '0.2.9'), 1)
assert.equal(compareSemver('0.2.2-rc.10', '0.2.2-rc.3'), 1)
assert.equal(compareSemver('0.2.2-beta', '0.2.2-rc'), -1)
assert.equal(compareSemver('0.2.2-rc', '0.2.2-rc.1'), -1)
assert.equal(compareSemver('x', '0.2.2'), undefined)

// 3. The range the manifest declares, evaluated the way DSH does it.
const range = '>=0.2.2-rc.3 <0.3.0'
assert.deepEqual(PLUGIN_MANIFEST.engines, { dsh: range })
assert.equal(versionSatisfies('0.2.2-rc.3', range), true)
assert.equal(versionSatisfies('0.2.2', range), true)
assert.equal(versionSatisfies('0.2.9', range), true)
assert.equal(versionSatisfies('0.2.2-rc.2', range), false)
assert.equal(versionSatisfies('0.2.1', range), false)
assert.equal(versionSatisfies('0.3.0', range), false)
assert.equal(versionSatisfies('1.0.0', range), false)
assert.equal(versionSatisfies('not-a-version', range), false)
assert.equal(versionSatisfies('0.2.2', ''), false)
assert.equal(versionSatisfies('0.2.2', '^0.2.0'), false, '只支持我们声明的比较符写法')
assert.equal(versionSatisfies('0.2.2', '>=0.2.0 <=0.2.2'), true)
assert.equal(versionSatisfies('0.2.3', '>=0.2.0 <=0.2.2'), false)

// 4. The runtime version is read from the installation, or reported unknown.
const runtime = dshRuntimeVersion()
assert.ok(runtime === '' || parseSemver(runtime) !== undefined)
if (runtime) assert.equal(typeof runtime, 'string')

console.log('compat: all assertions passed')
