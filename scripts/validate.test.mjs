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

test('meta-dump: envelope carries declaredNamespaces for every one-level key', () => {
  const res = runDump('ok-async.js');
  assert.equal(res.error, undefined);
  const envelope = parseSingleLine(res.stdout);
  // One-level key names of the factory result, insertion order,
  // regardless of whether the value is an object.
  assert.deepEqual(envelope.declaredNamespaces, ['endpoints', 'media', 'extras']);
});

test('meta-dump: a non-object namespace value is declared but collects no capability', () => {
  const res = runDump('bad-ns-value.js');
  assert.equal(res.error, undefined);
  const envelope = parseSingleLine(res.stdout);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.declaredNamespaces, ['media', 'search']);
  assert.equal(envelope.capabilities['media.getDetail'], true);
  assert.equal(envelope.capabilities['media.resolvePlayback'], true);
  assert.ok(
    !Object.keys(envelope.capabilities).some((k) => k.startsWith('search.')),
    JSON.stringify(envelope.capabilities),
  );
});

test('meta-dump: a throwing getter during collection is a factory-stage failure', () => {
  const res = runDump('bad-getter.js');
  assert.equal(res.error, undefined);
  const envelope = parseSingleLine(res.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.stage, 'factory');
  assert.match(envelope.message, /getter boom/);
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

test('rules: REQUIRED_METHODS matches the host inline required table exactly', () => {
  // Full-table pin (review I2): transcribed from the host inline required
  // table at prelude.js:166-168 (verified 2026-11-17), where articles/auth/ui
  // expand the `methods` collection-table references. Deliberately NOT the
  // full collection table — judging by it would fail plugins that legally
  // implement only the required subset.
  assert.deepEqual(REQUIRED_METHODS, {
    media: ['getDetail', 'resolvePlayback'],
    live: ['getGroups', 'listChannels', 'resolve'],
    articles: ['list', 'getDetail'],
    resolver: ['resolve'],
    search: ['search'],
    home: ['getSections'],
    catalog: ['getCategories', 'list'],
    feed: ['list'],
    endpoints: ['list'],
    auth: ['getMethods', 'submit', 'getProfile', 'logout'],
    ui: ['getActions', 'submit'],
    library: ['listMedia'],
    progress: ['report'],
    updates: ['check'],
    comments: ['list'],
    interact: [],
  });
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

test('rules: cap-03 flags a declared namespace whose value is not a method object', () => {
  // declaredNamespaces carries the declaration even when the value
  // is a string, so the required-method check still has something to judge.
  const dump = {
    ok: true,
    meta: { id: 'x', name: 'X', version: '1.0.0', protocol: 1, description: 'd', author: 't' },
    capabilities: { 'media.getDetail': true, 'media.resolvePlayback': true },
    declaredNamespaces: ['media', 'search'],
    fileName: 'x.js',
    fileSize: 2048,
  };
  const finding = assertFinding(checkPlugin(dump, { idCounts: new Map([['x', 1]]) }), 'cap-03', 'fail', 'x');
  assert.match(finding.message, /search/);
});

test('rules: cap-03 flags a declared-but-empty namespace (no capabilities at all)', () => {
  const dump = {
    ok: true,
    meta: { id: 'x', name: 'X', version: '1.0.0', protocol: 1, description: 'd', author: 't' },
    capabilities: { 'media.getDetail': true, 'media.resolvePlayback': true },
    declaredNamespaces: ['media', 'auth'],
    fileName: 'x.js',
    fileSize: 2048,
  };
  const finding = assertFinding(checkPlugin(dump, { idCounts: new Map([['x', 1]]) }), 'cap-03', 'fail', 'x');
  assert.match(finding.message, /auth/);
});

test('rules: cap-03 ignores out-of-table namespaces and passes complete ones', () => {
  const dump = {
    ok: true,
    meta: { id: 'x', name: 'X', version: '1.0.0', protocol: 1, description: 'd', author: 't' },
    capabilities: { 'media.getDetail': true, 'media.resolvePlayback': true, 'extras.ping': true },
    declaredNamespaces: ['media', 'extras'],
    fileName: 'x.js',
    fileSize: 2048,
  };
  assertNoFinding(checkPlugin(dump, { idCounts: new Map([['x', 1]]) }), 'cap-03');
});

test('rules: cap-03 survives prototype-key names in declaredNamespaces', () => {
  // 'hasOwnProperty'/'constructor' resolve to inherited functions on the
  // REQUIRED_METHODS object literal — the lookup must be own-property only
  // or the whole validator crashes with "methods.filter is not a function".
  const dump = {
    ok: true,
    meta: { id: 'x', name: 'X', version: '1.0.0', protocol: 1, description: 'd', author: 't' },
    capabilities: { 'media.getDetail': true, 'media.resolvePlayback': true },
    declaredNamespaces: ['media', 'hasOwnProperty', 'constructor', '__proto__'],
    fileName: 'x.js',
    fileSize: 2048,
  };
  const findings = checkPlugin(dump, { idCounts: new Map([['x', 1]]) }); // must not throw
  assertNoFinding(findings, 'cap-03');
});

test('rules: meta-04 bounds each segment at Number.MAX_SAFE_INTEGER', () => {
  assertNoFinding(findingsOf(makeDump({ meta: { version: '9007199254740991.0.0' } })), 'meta-04');
  assertFinding(findingsOf(makeDump({ meta: { version: '9007199254740992.0.0' } })), 'meta-04', 'fail');
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

// ---------------------------------------------------------------------------
// rules.mjs: checkLists (subscription-list consistency — repo invariants)
//
// Lists are constructed directly: the CLI owns reading/parsing and passes
// null for each missing OR unparsable list. The parse-failure list-04 with
// the file name is appended by the caller — checkLists cannot tell the two
// null causes apart, so a null list simply skips the rules that need it.
// ---------------------------------------------------------------------------

import { checkLists } from './rules.mjs';

function makeEntry(id, { version = '1.0.0', name = id, url = `plugins/${id}.js` } = {}) {
  return { id, name, version, url, description: `${id} 描述` };
}

function makeList(ids) {
  return { name: '测试列表', description: '描述', plugins: ids.map((id) => makeEntry(id)) };
}

function makeDumps(metas) {
  const dumps = new Map();
  for (const [id, m = {}] of Object.entries(metas)) {
    dumps.set(id, {
      ok: true,
      meta: { id, name: m.name ?? id, version: m.version ?? '1.0.0', protocol: 1, mature: m.mature ?? false },
    });
  }
  return dumps;
}

// Green baseline: three files, gamma the only mature plugin (in 18.json).
function greenLists() {
  return {
    manifest: makeList(['alpha', 'beta', 'gamma']),
    all: makeList(['alpha', 'beta', 'gamma']),
    vod: makeList(['alpha', 'beta']),
    nsfw18: makeList(['gamma']),
  };
}

const greenDumps = () => makeDumps({ alpha: {}, beta: {}, gamma: { mature: true } });
const greenFiles = () => new Set(['alpha', 'beta', 'gamma']);

function assertListFinding(findings, rule, severity, pluginId) {
  const hits = findings.filter((f) => f.rule === rule);
  assert.equal(hits.length, 1, `expected exactly one ${rule} finding, got ${JSON.stringify(findings)}`);
  assert.equal(hits[0].severity, severity);
  assert.equal(hits[0].pluginId, pluginId);
  assert.match(hits[0].message, new RegExp('^' + rule + ' '));
  return hits[0];
}

test('checkLists: consistent lists, dumps and files yield zero findings', () => {
  assert.deepEqual(checkLists(greenLists(), greenDumps(), greenFiles()), []);
});

test('checkLists: manifest version drift yields exactly one list-03 finding', () => {
  const lists = greenLists();
  lists.manifest.plugins[2].version = '2.0';
  const findings = checkLists(lists, greenDumps(), greenFiles());
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, 'list-03');
  assert.equal(findings[0].severity, 'fail');
  assert.equal(findings[0].pluginId, 'gamma');
  assert.match(findings[0].message, /manifest\.json/);
  assert.match(findings[0].message, /version/);
});

test('checkLists: list-01 flags list entries left without a plugin file', () => {
  const lists = greenLists();
  // plugins/ghost.js was deleted but every list still references it.
  for (const key of ['manifest', 'all', 'vod']) lists[key].plugins.push(makeEntry('ghost'));
  const finding = assertListFinding(checkLists(lists, greenDumps(), greenFiles()), 'list-01', 'fail', 'manifest.json');
  assert.match(finding.message, /ghost/);
});

test('checkLists: list-01 counts short-circuited plugin files too', () => {
  // deadloop.js exists (its dump failed — fileNames still includes it) but
  // no list references it.
  const files = new Set([...greenFiles(), 'deadloop']);
  const finding = assertListFinding(checkLists(greenLists(), greenDumps(), files), 'list-01', 'fail', 'manifest.json');
  assert.match(finding.message, /deadloop/);
});

test('checkLists: a short-circuited plugin only needs its file and list entries', () => {
  // deadloop is fully listed; without an ok dump there is nothing to compare
  // against (and a stray failure envelope in the map must be ignored).
  const lists = greenLists();
  for (const key of ['manifest', 'all', 'vod']) lists[key].plugins.push(makeEntry('deadloop'));
  const files = new Set([...greenFiles(), 'deadloop']);
  const dumps = greenDumps();
  dumps.set('deadloop', { ok: false, stage: 'factory', message: 'boom' });
  assert.deepEqual(checkLists(lists, dumps, files), []);
});

test('checkLists: list-02 flags all.json ids diverging from manifest ids', () => {
  const lists = greenLists();
  lists.all = makeList(['alpha', 'beta']); // gamma dropped from all.json
  lists.nsfw18 = makeList([]); // keep vod∪18 === all and mature off
  const dumps = makeDumps({ alpha: {}, beta: {}, gamma: {} });
  const finding = assertListFinding(checkLists(lists, dumps, greenFiles()), 'list-02', 'fail', 'subs/all.json');
  assert.match(finding.message, /gamma/);
});

test('checkLists: list-04 flags ids listed in both vod and 18', () => {
  const lists = greenLists();
  lists.nsfw18 = makeList(['beta', 'gamma']);
  const dumps = makeDumps({ alpha: {}, beta: { mature: true }, gamma: { mature: true } });
  const finding = assertListFinding(checkLists(lists, dumps, greenFiles()), 'list-04', 'fail', 'subs/all.json');
  assert.match(finding.message, /beta/);
});

test('checkLists: list-04 flags all ids uncovered by vod∪18', () => {
  const lists = greenLists();
  lists.nsfw18 = makeList([]); // gamma left 18.json
  const dumps = makeDumps({ alpha: {}, beta: {}, gamma: {} });
  const finding = assertListFinding(checkLists(lists, dumps, greenFiles()), 'list-04', 'fail', 'subs/all.json');
  assert.match(finding.message, /gamma/);
});

test('checkLists: list-04 flags vod∪18 ids missing from all', () => {
  const lists = greenLists();
  lists.vod = makeList(['alpha', 'beta', 'delta']);
  const finding = assertListFinding(checkLists(lists, greenDumps(), greenFiles()), 'list-04', 'fail', 'subs/all.json');
  assert.match(finding.message, /delta/);
});

test('checkLists: a null list skips exactly the rules that need it', () => {
  for (const key of ['manifest', 'all', 'vod', 'nsfw18']) {
    const lists = greenLists();
    lists[key] = null; // missing or unparsable — indistinguishable here
    assert.deepEqual(checkLists(lists, greenDumps(), greenFiles()), [], `${key} = null must skip its rules`);
  }
  // Without the full file scan list-01 cannot run either.
  assert.deepEqual(checkLists(greenLists(), greenDumps(), null), []);
});

test('checkLists: warn-02 flags a mature plugin missing from 18.json', () => {
  const lists = greenLists();
  lists.vod = makeList(['alpha', 'beta', 'gamma']); // gamma stayed in vod.json
  lists.nsfw18 = makeList([]);
  const finding = assertListFinding(checkLists(lists, greenDumps(), greenFiles()), 'warn-02', 'warn', 'gamma');
  assert.match(finding.message, /18\.json/);
  assert.match(finding.message, /build-subs/);
});

test('checkLists: warn-02 flags a non-mature plugin listed in 18.json', () => {
  const dumps = makeDumps({ alpha: {}, beta: {}, gamma: {} });
  const finding = assertListFinding(checkLists(greenLists(), dumps, greenFiles()), 'warn-02', 'warn', 'gamma');
  assert.match(finding.message, /18\.json/);
});

test('checkLists: list-03 checks name and url per list file', () => {
  const nameDrift = greenLists();
  nameDrift.vod.plugins[0].name = '阿尔法';
  const nameFinding = assertListFinding(checkLists(nameDrift, greenDumps(), greenFiles()), 'list-03', 'fail', 'alpha');
  assert.match(nameFinding.message, /subs\/vod\.json/);
  assert.match(nameFinding.message, /name/);

  const urlDrift = greenLists();
  urlDrift.nsfw18.plugins[0].url = 'plugins/wrong.js';
  const urlFinding = assertListFinding(checkLists(urlDrift, greenDumps(), greenFiles()), 'list-03', 'fail', 'gamma');
  assert.match(urlFinding.message, /subs\/18\.json/);
  assert.match(urlFinding.message, /url/);
});

test('checkLists: the same drift in several lists yields one finding per entry', () => {
  const lists = greenLists();
  lists.manifest.plugins[0].version = '2.0';
  lists.all.plugins[0].version = '2.0';
  const findings = checkLists(lists, greenDumps(), greenFiles());
  assert.equal(findings.length, 2, JSON.stringify(findings));
  assert.ok(findings.every((f) => f.rule === 'list-03' && f.pluginId === 'alpha'));
  assert.ok(findings.some((f) => f.message.includes('manifest.json')));
  assert.ok(findings.some((f) => f.message.includes('subs/all.json')));
});

test('checkLists: ill-typed meta values stay meta-01 business (list-03 skips them)', () => {
  const dumps = greenDumps();
  dumps.get('alpha').meta.name = 123;
  dumps.get('beta').meta.version = null;
  assert.deepEqual(checkLists(greenLists(), dumps, greenFiles()), []);
});

test('checkLists: empty or absent inputs yield no findings', () => {
  assert.deepEqual(checkLists({}, new Map(), new Set()), []);
  assert.deepEqual(checkLists(null, null, null), []);
});

// ---------------------------------------------------------------------------
// validate.mjs: main-process short-circuits (runValidate direct) + CLI
// integration. Temporary roots copy fixtures into <t>/plugins/ (never
// symlink) and write their own lists on demand; CLI cases run as child
// processes so the exit code and the spawn/kill watchdog are both real.
// ---------------------------------------------------------------------------

import { runValidate } from './validate.mjs';
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const validateScript = path.join(here, 'validate.mjs');

function makeTempRoot(fixtureNames) {
  const root = mkdtempSync(path.join(tmpdir(), 'hghub-validate-'));
  mkdirSync(path.join(root, 'plugins'));
  for (const name of fixtureNames) {
    cpSync(path.join(fixturesDir, name), path.join(root, 'plugins', name));
  }
  return root;
}

function runCli(args, { timeout = 15000 } = {}) {
  return spawnSync(process.execPath, [validateScript, ...args], { encoding: 'utf8', timeout });
}

function okPluginSource(id, name) {
  return `export const meta = { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, version: '1.0.0', protocol: 1, description: 'd', author: 't' };\n`
    + 'export default function factory() {\n'
    + '  return { media: { getDetail() {}, resolvePlayback() {} } };\n'
    + '}\n';
}

test('validate: file-01 short-circuits a >2MiB plugin before any spawn', async () => {
  const root = makeTempRoot([]);
  try {
    // Valid JS padded past the 2MiB host cap with a comment block.
    const padding = '// ' + 'x'.repeat(3 * 1024 * 1024) + '\n';
    const bigPath = path.join(root, 'plugins', 'big.js');
    writeFileSync(bigPath, padding + okPluginSource('big', 'Big'));
    assert.ok(statSync(bigPath).size > 2 * 1024 * 1024);

    const { exitCode, lines } = await runValidate({ root });
    assert.equal(exitCode, 1);
    const file01 = lines.filter((l) => l.includes('[file-01]'));
    assert.equal(file01.length, 1, JSON.stringify(lines));
    assert.ok(file01[0].startsWith('FAIL big — [file-01]'), file01[0]);
    assert.ok(!lines.some((l) => l.includes('dump-01')), 'file-01 must short-circuit before spawn: ' + JSON.stringify(lines));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate: meta-03 flags a duplicate id across two files in one root', async () => {
  const root = makeTempRoot([]);
  try {
    // Both files declare id 'a'; only a.js matches its file stem.
    writeFileSync(path.join(root, 'plugins', 'a.js'), okPluginSource('a', 'Dup A'));
    writeFileSync(path.join(root, 'plugins', 'b.js'), okPluginSource('a', 'Dup B'));
    const { exitCode, lines } = await runValidate({ root });
    assert.equal(exitCode, 1);
    const meta03 = lines.filter((l) => l.includes('[meta-03]'));
    assert.ok(meta03.length >= 1, JSON.stringify(lines));
    assert.ok(meta03.some((l) => l.includes('重复') && l.includes('2 处')), JSON.stringify(meta03));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate: meta-08 is the only finding for a plugin missing the default export', async () => {
  const root = makeTempRoot(['bad-exports.js']);
  try {
    const { exitCode, lines } = await runValidate({ root, plugin: 'bad-exports' });
    assert.equal(exitCode, 1);
    const fails = lines.filter((l) => l.startsWith('FAIL'));
    assert.equal(fails.length, 1, JSON.stringify(lines));
    assert.ok(fails[0].includes('[meta-08]'), fails[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate CLI: bad-deadloop times out to exactly one dump-01 with exit code 1', () => {
  const root = makeTempRoot(['bad-deadloop.js']);
  try {
    const start = Date.now();
    const res = runCli(['--plugin', 'bad-deadloop', '--root', root, '--timeout', '2000']);
    const elapsed = Date.now() - start;
    assert.equal(res.error, undefined);
    assert.equal(res.status, 1, 'outer 15s watchdog must not fire');
    assert.ok(elapsed >= 2000 && elapsed < 12000, `elapsed ${elapsed}ms outside [2000, 12000)`);
    const dump01 = res.stdout.split('\n').filter((l) => l.includes('[dump-01]'));
    assert.equal(dump01.length, 1, res.stdout);
    assert.match(dump01[0], /超时/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate CLI: ok-min passes with exit code 0 in a manifest-less root', () => {
  const root = makeTempRoot(['ok-min.js']);
  try {
    const res = runCli(['--plugin', 'ok-min', '--root', root]);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^PASS ok-min$/m);
    assert.match(res.stdout, /校验完成/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate CLI: bad-meta yields at least two distinct meta-* FAILs and no dump-01', () => {
  const root = makeTempRoot(['bad-meta.js']);
  try {
    const res = runCli(['--plugin', 'bad-meta', '--root', root]);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 1);
    const rules = new Set([...res.stdout.matchAll(/\[(meta-[^\]]+)\]/g)].map((m) => m[1]));
    assert.ok(rules.size >= 2, res.stdout);
    assert.ok(!res.stdout.includes('dump-01'), res.stdout);
    // Per-plugin summary counts: three FAIL findings, still one failing plugin.
    assert.match(res.stdout, /1 个插件：0 全通过，1 失败，0 仅警告/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate CLI: bad-factory yields exactly one dump-01 from the factory stage', () => {
  const root = makeTempRoot(['bad-factory.js']);
  try {
    const res = runCli(['--plugin', 'bad-factory', '--root', root]);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 1);
    const dump01 = res.stdout.split('\n').filter((l) => l.includes('[dump-01]'));
    assert.equal(dump01.length, 1, res.stdout);
    assert.match(dump01[0], /工厂/);
    assert.match(dump01[0], /factory exploded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate CLI: manifest version drift yields exactly one list-03', () => {
  const root = makeTempRoot(['ok-min.js']);
  try {
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
      name: '测试清单',
      description: '描述',
      plugins: [{
        id: 'ok-min',
        name: 'OK Minimal Fixture',
        version: '2.0',
        url: 'plugins/ok-min.js',
        description: 'x',
      }],
    }, null, 2));
    const res = runCli(['--plugin', 'ok-min', '--root', root]);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 1);
    const fails = res.stdout.split('\n').filter((l) => l.startsWith('FAIL'));
    assert.equal(fails.length, 1, res.stdout);
    assert.ok(fails[0].includes('[list-03]'), fails[0]);
    for (const rule of ['list-01', 'list-02', 'list-04', 'warn-02']) {
      assert.ok(!res.stdout.includes(rule), `${rule} must not fire in --plugin mode: ` + res.stdout);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate CLI: --help prints Chinese usage covering all four options', () => {
  const res = runCli(['--help']);
  assert.equal(res.error, undefined);
  assert.equal(res.status, 0);
  for (const opt of ['--plugin', '--root', '--timeout', '--help']) {
    assert.ok(res.stdout.includes(opt), `help must mention ${opt}: ` + res.stdout);
  }
});

test('validate: an extra export yields exactly one meta-08 on an otherwise-clean plugin', async () => {
  const root = makeTempRoot(['bad-extra-export.js']);
  try {
    const { exitCode, lines } = await runValidate({ root, plugin: 'bad-extra-export' });
    assert.equal(exitCode, 1);
    const fails = lines.filter((l) => l.startsWith('FAIL'));
    assert.equal(fails.length, 1, JSON.stringify(lines));
    assert.ok(fails[0].includes('[meta-08]'), fails[0]);
    assert.match(fails[0], /helper/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate: a non-object namespace value yields exactly one cap-03', async () => {
  const root = makeTempRoot(['bad-ns-value.js']);
  try {
    const { exitCode, lines } = await runValidate({ root, plugin: 'bad-ns-value' });
    assert.equal(exitCode, 1);
    const fails = lines.filter((l) => l.startsWith('FAIL'));
    assert.equal(fails.length, 1, JSON.stringify(lines));
    assert.ok(fails[0].includes('[cap-03]'), fails[0]);
    assert.match(fails[0], /search/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate CLI: usage and environment errors exit 2', () => {
  const root = makeTempRoot(['ok-min.js']);
  try {
    const cases = [
      [['--plugin', 'ghost', '--root', root], 'missing plugin file'],
      [['--timeout', '0'], 'timeout zero'],
      [['--timeout', '-5'], 'timeout negative'],
      [['--timeout', 'abc'], 'timeout non-numeric'],
      [['--timeout', '2147483648'], 'timeout above 2^31-1'],
      [['--timeout'], 'missing option value'],
      [['--bogus'], 'unknown option'],
    ];
    for (const [args, why] of cases) {
      const res = runCli(args);
      assert.equal(res.status, 2, `${why}: ${res.stdout}${res.stderr}`);
    }
    const noPlugins = runCli(['--root', path.join(root, 'no-such-dir')]);
    assert.equal(noPlugins.status, 2, 'missing plugins dir');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate: runaway stderr trips the output cap as dump-01', async () => {
  const root = makeTempRoot(['bad-noise.js']);
  try {
    const { exitCode, lines } = await runValidate({ root, plugin: 'bad-noise', timeout: 8000 });
    assert.equal(exitCode, 1);
    const dump01 = lines.filter((l) => l.includes('[dump-01]'));
    assert.equal(dump01.length, 1, JSON.stringify(lines));
    assert.match(dump01[0], /输出超限/);
    assert.match(dump01[0], /stderr/);
    // The cap must fire long before the timeout: the kill happens after a
    // couple of 64KiB stderr chunks, not after 8s.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate: report lines strip control characters and keep factory-stage attribution', async () => {
  const root = makeTempRoot(['bad-getter.js']);
  try {
    const { exitCode, lines } = await runValidate({ root, plugin: 'bad-getter' });
    assert.equal(exitCode, 1);
    const dump01 = lines.filter((l) => l.includes('[dump-01]'));
    assert.equal(dump01.length, 1, JSON.stringify(lines));
    // Throwing getter during collection is factory-stage (review M1)...
    assert.match(dump01[0], /工厂执行失败/);
    // ...and its ESC/BEL characters never reach the report (review M3).
    assert.ok(!dump01[0].includes('\x1b'), JSON.stringify(dump01[0]));
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(dump01[0]), JSON.stringify(dump01[0]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate CLI: bad-syntax import failure is a dump-01 in --plugin mode', () => {
  const root = makeTempRoot(['bad-syntax.js']);
  try {
    const res = runCli(['--plugin', 'bad-syntax', '--root', root]);
    assert.equal(res.status, 1);
    const dump01 = res.stdout.split('\n').filter((l) => l.includes('[dump-01]'));
    assert.equal(dump01.length, 1, res.stdout);
    assert.match(dump01[0], /导入失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate: non-object meta maps to exactly one meta-08', async () => {
  const root = makeTempRoot(['bad-meta-object.js']);
  try {
    const { exitCode, lines } = await runValidate({ root, plugin: 'bad-meta-object' });
    assert.equal(exitCode, 1);
    const fails = lines.filter((l) => l.startsWith('FAIL'));
    assert.equal(fails.length, 1, JSON.stringify(lines));
    assert.ok(fails[0].includes('[meta-08]'), fails[0]);
    assert.match(fails[0], /meta must be an exported object/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate CLI: unparsable manifest reports list-04 even in --plugin mode', () => {
  const root = makeTempRoot(['ok-min.js']);
  try {
    writeFileSync(path.join(root, 'manifest.json'), '{ broken json');
    const res = runCli(['--plugin', 'ok-min', '--root', root]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /\[list-04\]/);
    assert.match(res.stdout, /manifest\.json/);
    // The plugin itself is fine; only the list problem is reported.
    assert.match(res.stdout, /^PASS ok-min$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate: a symlinked plugin file is ignored by the scan', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'hghub-validate-'));
  try {
    mkdirSync(path.join(root, 'plugins'));
    cpSync(path.join(fixturesDir, 'ok-min.js'), path.join(root, 'plugins', 'ok-min.js'));
    try {
      symlinkSync('ok-min.js', path.join(root, 'plugins', 'linked.js'));
    } catch {
      t.skip('creating a symlink requires privileges on this platform');
      return;
    }
    const { exitCode, lines } = await runValidate({ root });
    assert.equal(exitCode, 0, JSON.stringify(lines));
    assert.deepEqual(lines.filter((l) => l.startsWith('PASS')), ['PASS ok-min'], JSON.stringify(lines));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate: control characters in plugin ids cannot forge report lines', async () => {
  const root = makeTempRoot(['bad-inject.js']);
  try {
    const { exitCode, lines } = await runValidate({ root, plugin: 'bad-inject' });
    assert.equal(exitCode, 1);
    // No forged standalone PASS line and no embedded newline anywhere —
    // every report line must be a single line of printable text.
    assert.ok(!lines.some((l) => l.startsWith('PASS totally-fine')), JSON.stringify(lines));
    assert.ok(
      lines.every((l) => !/[\u0000-\u001F\u007F-\u009F]/.test(l)),
      JSON.stringify(lines),
    );
    // The attack text stays inline on the FAIL line instead of breaking it.
    const failLine = lines.find((l) => l.includes('[meta-02]'));
    assert.ok(failLine, JSON.stringify(lines));
    assert.ok(failLine.includes('PASS totally-fine'), failLine);
    assert.ok(failLine.startsWith('FAIL evil'), failLine);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate CLI: warn-only plugin exits 0 with a WARN line', () => {
  const root = makeTempRoot(['ok-no-desc.js']);
  try {
    const res = runCli(['--plugin', 'ok-no-desc', '--root', root]);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 0); // WARN never fails the run (CI contract)
    assert.match(res.stdout, /^WARN ok-no-desc — \[warn-03\]/m);
    assert.ok(!res.stdout.split('\n').some((l) => l.startsWith('FAIL')), res.stdout);
    assert.match(res.stdout, /1 个插件：0 全通过，0 失败，1 仅警告/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
