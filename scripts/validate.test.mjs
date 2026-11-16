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

// ---------------------------------------------------------------------------
// rules.mjs: checkPlugin + parseEnvelope (contract rules engine)
//
// Dumps are constructed directly from the cached ok-async envelope; each rule
// gets one negative and one positive case. Positive cases exercise paths the
// base envelope does not cover (resolver kind, settings/timeouts/requires).
// ---------------------------------------------------------------------------

import { before } from 'node:test';
import { checkPlugin, parseEnvelope, REQUIRED_METHODS } from './rules.mjs';

let baseEnvelope;

before(() => {
  const res = runDump('ok-async.js');
  assert.equal(res.error, undefined);
  assert.equal(res.status, 0);
  baseEnvelope = parseSingleLine(res.stdout);
  assert.equal(baseEnvelope.ok, true);
});

function fileStem(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function makeDump({ meta: metaOverrides, capabilities, fileName = 'ok-async.js', fileSize = 2048 } = {}) {
  const dump = { ...structuredClone(baseEnvelope), fileName, fileSize };
  if (metaOverrides) dump.meta = { ...dump.meta, ...metaOverrides };
  if (capabilities) dump.capabilities = capabilities;
  return dump;
}

function soloCtx() {
  return { idCounts: new Map([['ok-async', 1]]) };
}

function findingsOf(dump, ctx = soloCtx()) {
  return checkPlugin(dump, ctx);
}

function assertFinding(findings, rule, severity, pluginId = 'ok-async') {
  const hits = findings.filter((f) => f.rule === rule);
  assert.equal(
    hits.length,
    1,
    `expected exactly one ${rule} finding, got ${JSON.stringify(findings)}`,
  );
  assert.equal(hits[0].severity, severity);
  assert.equal(hits[0].pluginId, pluginId);
  assert.match(hits[0].message, new RegExp('^' + rule + ' '));
  return hits[0];
}

function assertNoFinding(findings, rule) {
  assert.equal(
    findings.filter((f) => f.rule === rule).length,
    0,
    `expected no ${rule} finding, got ${JSON.stringify(findings)}`,
  );
}

test('rules: ok-async envelope passes checkPlugin with zero findings', () => {
  assert.deepEqual(findingsOf(makeDump()), []);
});

test('rules: REQUIRED_METHODS is the host inline required table, not the full collection table', () => {
  assert.deepEqual(REQUIRED_METHODS.media, ['getDetail', 'resolvePlayback']);
  assert.deepEqual(REQUIRED_METHODS.live, ['getGroups', 'listChannels', 'resolve']);
  assert.deepEqual(REQUIRED_METHODS.articles, ['list', 'getDetail']);
  assert.deepEqual(REQUIRED_METHODS.resolver, ['resolve']);
  assert.deepEqual(REQUIRED_METHODS.search, ['search']);
  assert.deepEqual(REQUIRED_METHODS.home, ['getSections']);
  assert.deepEqual(REQUIRED_METHODS.catalog, ['getCategories', 'list']);
  assert.deepEqual(REQUIRED_METHODS.auth, ['getMethods', 'submit', 'getProfile', 'logout']);
  assert.deepEqual(REQUIRED_METHODS.interact, []);
});

test('rules: meta-01 flags declared fields with wrong types', () => {
  const dump = makeDump({ meta: {
    matches: 'https://example.com',
    defaultHeaders: ['x'],
    timeouts: 'read',
    requires: [{ type: 'api' }],
    allowInsecureHttp: 'yes',
    settings: { key: 'a' },
  } });
  assertFinding(findingsOf(dump), 'meta-01', 'fail');
});

test('rules: meta-01 accepts typed fields and ignores unknown ones', () => {
  const dump = makeDump({ meta: {
    matches: ['example.com'],
    linkDomains: ['cdn.example.com'],
    features: ['charset.legacy'],
    defaultHeaders: { 'x-flag': '1' },
    timeouts: { read: 15 },
    requires: [{ type: 'api', name: 'http.fetch' }],
    allowInsecureHttp: false,
    mature: false,
    settings: [{ key: 'a', label: 'A', type: 'text' }],
    customField: { anything: true },
  } });
  assertNoFinding(findingsOf(dump), 'meta-01');
});

test('rules: meta-02 rejects bad id format, reserved names and trailing dot', () => {
  const bad = makeDump({ meta: { id: 'BadId' }, fileName: 'BadId.js' });
  assertFinding(checkPlugin(bad, { idCounts: new Map([['BadId', 1]]) }), 'meta-02', 'fail', 'BadId');

  const reserved = makeDump({ meta: { id: 'com1' }, fileName: 'com1.js' });
  assertFinding(checkPlugin(reserved, { idCounts: new Map([['com1', 1]]) }), 'meta-02', 'fail', 'com1');

  const dotted = makeDump({ meta: { id: 'ok.' }, fileName: 'ok..js' });
  assertFinding(checkPlugin(dotted, { idCounts: new Map([['ok.', 1]]) }), 'meta-02', 'fail', 'ok.');

  assertNoFinding(findingsOf(makeDump()), 'meta-02');
});

test('rules: meta-03 flags duplicate ids across the repo and id/file mismatches', () => {
  const dup = findingsOf(makeDump(), { idCounts: new Map([['ok-async', 2]]) });
  assertFinding(dup, 'meta-03', 'fail');

  const mismatch = findingsOf(makeDump({ fileName: 'other.js' }));
  assertFinding(mismatch, 'meta-03', 'fail');

  assertNoFinding(findingsOf(makeDump()), 'meta-03');
});

test('rules: meta-04 rejects "1.02.0", "1.0" and "1.0.0.0" but accepts "1.0.0"', () => {
  for (const version of ['1.02.0', '1.0', '1.0.0.0']) {
    assertFinding(findingsOf(makeDump({ meta: { version } })), 'meta-04', 'fail');
  }
  assertNoFinding(findingsOf(makeDump()), 'meta-04');
});

test('rules: meta-05 enforces code-point lengths (61 emoji) and non-blank name', () => {
  const emoji = '\u{1F600}';
  const longName = findingsOf(makeDump({ meta: { name: emoji.repeat(61) } }));
  assertFinding(longName, 'meta-05', 'fail');

  const blankName = findingsOf(makeDump({ meta: { name: '   ' } }));
  assertFinding(blankName, 'meta-05', 'fail');

  const longDescription = findingsOf(makeDump({ meta: { description: 'x'.repeat(501) } }));
  assertFinding(longDescription, 'meta-05', 'fail');

  // 60 emoji are 60 code points (but 120 UTF-16 code units) — must pass.
  assertNoFinding(findingsOf(makeDump({ meta: { name: emoji.repeat(60) } })), 'meta-05');
});

test('rules: meta-06 requires protocol 1', () => {
  assertFinding(findingsOf(makeDump({ meta: { protocol: 2 } })), 'meta-06', 'fail');
  assertNoFinding(findingsOf(makeDump()), 'meta-06');
});

test('rules: meta-07 validates kind and resolver matches', () => {
  const badKind = findingsOf(makeDump({ meta: { kind: 'widget' } }));
  assertFinding(badKind, 'meta-07', 'fail');

  const noMatches = findingsOf(makeDump({
    meta: { kind: 'resolver', matches: [] },
    capabilities: { 'resolver.resolve': true },
  }));
  assertFinding(noMatches, 'meta-07', 'fail');

  const resolverOk = findingsOf(makeDump({
    meta: { kind: 'resolver', matches: ['example.com'] },
    capabilities: { 'resolver.resolve': true },
  }));
  assertNoFinding(resolverOk, 'meta-07');
});

test('rules: meta-07 flags resolvers with a missing matches field', () => {
  // Host serde defaults an absent matches to an empty vec (model.rs:24),
  // which is then rejected for resolvers — the same FAIL shape as [].
  const dump = makeDump({
    meta: { kind: 'resolver' },
    capabilities: { 'resolver.resolve': true },
  });
  assertFinding(findingsOf(dump), 'meta-07', 'fail');
});

test('rules: meta-09 validates settings shape, uniqueness and defaults', () => {
  const dump = makeDump({ meta: { settings: [
    { key: 'a', label: 'A', type: 'text' },
    { key: 'a', label: 'A2', type: 'text' },
    { label: 'C', type: 'text' },
    { key: 'd', type: 'text' },
    { key: 'e', label: 'E', type: 'color' },
    { key: 'f', label: 'F', type: 'select', options: [] },
    { key: 'g', label: 'G', type: 'select', options: [{ value: 'x' }], default: 'y' },
    { key: 'h', label: 'H', type: 'switch', default: 'on' },
  ] } });
  const finding = assertFinding(findingsOf(dump), 'meta-09', 'fail');
  // 7 distinct violations of one rule are joined into a single message.
  assert.equal(finding.message.split('; ').length, 7, finding.message);

  const ok = makeDump({ meta: { settings: [
    { key: 'a', label: 'A', type: 'select', options: [{ value: 'x', label: 'X' }], default: 'x' },
    { key: 'b', label: 'B', type: 'number', default: 5, min: 0, max: 10 },
    { key: 'c', label: 'C', type: 'switch', default: false },
  ] } });
  assertNoFinding(findingsOf(ok), 'meta-09');
});

test('rules: meta-10 requires positive timeouts with known keys', () => {
  const dump = makeDump({ meta: { timeouts: { read: -5, playback: 0, bogus: 10 } } });
  const finding = assertFinding(findingsOf(dump), 'meta-10', 'fail');
  assert.equal(finding.message.split('; ').length, 3, finding.message);

  assertNoFinding(findingsOf(makeDump({ meta: { timeouts: { read: 15, login: 30 } } })), 'meta-10');
});

test('rules: meta-11 validates domain patterns, header values and settings labels', () => {
  const dump = makeDump({ meta: {
    matches: ['Example.com'],
    linkDomains: ['bad host'],
    defaultHeaders: { 'x-flag': 123 },
    settings: [{ key: 'a', label: '   ', type: 'text' }],
  } });
  const finding = assertFinding(findingsOf(dump), 'meta-11', 'fail');
  assert.equal(finding.message.split('; ').length, 4, finding.message);

  const ok = makeDump({ meta: {
    matches: ['example.com'],
    linkDomains: ['cdn.example.com', 'a-b.io'],
    defaultHeaders: { 'x-flag': '1' },
    settings: [{ key: 'a', label: 'A', type: 'text' }],
  } });
  assertNoFinding(findingsOf(ok), 'meta-11');
});

test('rules: meta-12 validates requires against the host whitelist', () => {
  const dump = makeDump({ meta: { requires: [
    { type: 'api', name: 'fs.read' },
    { type: 'feature', name: 'dark-mode' },
    { type: 'driver', name: 'gpu' },
  ] } });
  const finding = assertFinding(findingsOf(dump), 'meta-12', 'fail');
  assert.equal(finding.message.split('; ').length, 3, finding.message);

  const ok = makeDump({ meta: { requires: [
    { type: 'api', name: 'http.fetch' },
    { type: 'feature', name: 'charset.legacy' },
    { type: 'api', name: 'settings.getAll' },
  ] } });
  assertNoFinding(findingsOf(ok), 'meta-12');
});

test('rules: cap-01 flags factories that expose no capability at all', () => {
  assertFinding(findingsOf(makeDump({ capabilities: {} })), 'cap-01', 'fail');
  assertNoFinding(findingsOf(makeDump()), 'cap-01');
});

test('rules: cap-02 requires media.* or live.resolve for source plugins', () => {
  // Only articles.* does not make a legal source.
  const articlesOnly = makeDump({ capabilities: { 'articles.list': true, 'articles.getDetail': true } });
  assertFinding(findingsOf(articlesOnly), 'cap-02', 'fail');

  // A complete live triad is a legal source too.
  const liveOnly = makeDump({ capabilities: {
    'live.getGroups': true,
    'live.listChannels': true,
    'live.resolve': true,
  } });
  assertNoFinding(findingsOf(liveOnly), 'cap-02');

  assertNoFinding(findingsOf(makeDump()), 'cap-02');
});

test('rules: cap-03 flags declared namespaces with missing required methods', () => {
  const mediaHalf = makeDump({ capabilities: { 'media.getDetail': true } });
  assertFinding(findingsOf(mediaHalf), 'cap-03', 'fail');

  const authPartial = makeDump({ capabilities: { 'auth.getMethods': true } });
  assertFinding(findingsOf(authPartial), 'cap-03', 'fail');

  assertNoFinding(findingsOf(makeDump()), 'cap-03');
});

test('rules: cap-04 requires media.getDetail alongside entry-point capabilities', () => {
  const homeOnly = makeDump({ capabilities: { 'home.getSections': true } });
  assertFinding(findingsOf(homeOnly), 'cap-04', 'fail');

  const homeWithMedia = makeDump({ capabilities: {
    'home.getSections': true,
    'media.getDetail': true,
    'media.resolvePlayback': true,
  } });
  assertNoFinding(findingsOf(homeWithMedia), 'cap-04');

  assertNoFinding(findingsOf(makeDump()), 'cap-04');
});

test('rules: cap-05 requires resolver.resolve for resolver kind', () => {
  const resolverNoResolve = makeDump({
    meta: { kind: 'resolver', matches: ['example.com'] },
    capabilities: { 'media.getDetail': true, 'media.resolvePlayback': true },
  });
  assertFinding(findingsOf(resolverNoResolve), 'cap-05', 'fail');

  const resolverOk = makeDump({
    meta: { kind: 'resolver', matches: ['example.com'] },
    capabilities: { 'resolver.resolve': true },
  });
  assertNoFinding(findingsOf(resolverOk), 'cap-05');
});

test('rules: warn-01 warns about non-kebab-case ids', () => {
  const underscored = makeDump({ meta: { id: 'ok_async' }, fileName: 'ok_async.js' });
  const findings = checkPlugin(underscored, { idCounts: new Map([['ok_async', 1]]) });
  assertFinding(findings, 'warn-01', 'warn', 'ok_async');

  assertNoFinding(findingsOf(makeDump()), 'warn-01');
});

test('rules: warn-03 warns about missing description or author', () => {
  const dump = makeDump({ meta: { description: undefined, author: undefined } });
  const finding = assertFinding(findingsOf(dump), 'warn-03', 'warn');
  assert.equal(finding.message.split('; ').length, 2, finding.message);

  assertNoFinding(findingsOf(makeDump()), 'warn-03');
});

test('rules: pluginId falls back to the file name stem when meta.id is empty', () => {
  const findings = findingsOf(makeDump({ meta: { id: '' } }));
  assert.ok(findings.length >= 1, 'expected at least one finding for an empty id');
  for (const f of findings) assert.equal(f.pluginId, 'ok-async');
});

test('rules: checkPlugin ignores non-ok envelopes (short-circuited by the CLI)', () => {
  assert.deepEqual(checkPlugin({ ok: false, stage: 'import', message: 'x' }, soloCtx()), []);
});

test('parseEnvelope: returns the parsed object for a clean single JSON line', () => {
  const text = JSON.stringify({ ok: true, meta: { id: 'x' }, capabilities: {} }) + '\n';
  assert.deepEqual(parseEnvelope(text, 'x'), { ok: true, meta: { id: 'x' }, capabilities: {} });
  assert.deepEqual(parseEnvelope(JSON.stringify(baseEnvelope) + '\n', 'ok-async'), baseEnvelope);
});

test('parseEnvelope: prefix or suffix noise yields dump-01', () => {
  const clean = JSON.stringify({ ok: true, meta: {}, capabilities: {} });
  assert.deepEqual(parseEnvelope('noise ' + clean, 'p1'), {
    rule: 'dump-01', severity: 'fail', pluginId: 'p1', message: '输出被污染',
  });
  assert.deepEqual(parseEnvelope(clean + ' trailing', 'p2'), {
    rule: 'dump-01', severity: 'fail', pluginId: 'p2', message: '输出被污染',
  });
});

test('parseEnvelope: valid JSON that is not an envelope object also yields dump-01', () => {
  for (const text of ['', '42', '"hello"', '[1,2]', 'null']) {
    assert.deepEqual(parseEnvelope(text, 'p'), {
      rule: 'dump-01', severity: 'fail', pluginId: 'p', message: '输出被污染',
    });
  }
});
