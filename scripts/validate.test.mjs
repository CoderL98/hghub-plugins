import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dumpScript = path.join(here, 'meta-dump.mjs');
const fixturesDir = path.join(here, 'fixtures');

function runDump(fixtureName) {
  const pluginPath = path.join(fixturesDir, fixtureName);
  return spawnSync(process.execPath, [dumpScript, pluginPath], {
    encoding: 'utf8',
    timeout: 15000,
  });
}

function parseSingleLine(stdout) {
  const lines = stdout.trim().split('\n');
  assert.equal(
    lines.length,
    1,
    'expected exactly one stdout line, got ' + lines.length + ': ' + JSON.stringify(lines),
  );
  return JSON.parse(lines[0]);
}

test('meta-dump: ok-async envelope reports meta, moduleExports and full capabilities', () => {
  const res = runDump('ok-async.js');
  assert.equal(res.error, undefined);
  assert.equal(res.status, 0);
  const envelope = parseSingleLine(res.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.id, 'ok-async');
  assert.equal(envelope.moduleExports.meta, 'object');
  assert.equal(envelope.moduleExports.default, 'function');
  assert.equal(envelope.capabilities['endpoints.list'], true);
  assert.equal(envelope.capabilities['media.getDetail'], true);
  assert.equal(envelope.capabilities['media.resolvePlayback'], true);
  // Out-of-table namespace must be collected too (full two-level sweep, no method table).
  assert.equal(envelope.capabilities['extras.ping'], true);
});

test('meta-dump: bad-syntax yields an import-stage failure envelope with exit code 0', () => {
  const res = runDump('bad-syntax.js');
  assert.equal(res.error, undefined);
  assert.equal(res.status, 0);
  const envelope = parseSingleLine(res.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.stage, 'import');
  assert.equal(typeof envelope.message, 'string');
  assert.notEqual(envelope.message, '');
});

test('meta-dump: bad-logs keeps stdout to exactly one valid JSON line', () => {
  const res = runDump('bad-logs.js');
  assert.equal(res.error, undefined);
  assert.equal(res.status, 0);
  const envelope = parseSingleLine(res.stdout);
  assert.equal(envelope.ok, true);
  // Plugin console noise must be redirected to stderr, never stdout.
  assert.match(res.stderr, /top-level noise/);
  assert.match(res.stderr, /factory noise/);
});
