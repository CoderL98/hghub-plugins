// Plugin contract rules engine — pure functions, no IO.
//
// checkPlugin consumes a success envelope from scripts/meta-dump.mjs
// ({ok: true, meta, moduleExports, capabilities, declaredNamespaces}) merged
// by the caller with {fileName, fileSize}. Envelope failures (import/factory
// error, timeout,
// polluted output) and the pre-spawn size check (file-01) are short-circuited
// by the CLI before this engine runs, so meta-08 / file-01 / dump-01 are not
// rules here; parseEnvelope produces the dump-01 finding for polluted stdout.
//
// Host-behaviour citations, HGhub upstream repo (verified 2026-11-17):
//   prelude.js — src-tauri/crates/hpp/src/prelude.js
//   model.rs   — src-tauri/crates/hpp/src/model.rs
//   manager.rs — src-tauri/crates/hpp/src/manager.rs
//   runtime.rs — src-tauri/crates/hpp/src/runtime.rs
//
// Layering convention to keep one violation in one rule: meta-01 owns the
// *shape* of declared fields (container types and item types); value-level
// rules (meta-04/05/10/11/12, meta-09 item shape) only judge values that are
// already well-typed and silently skip the rest.

// Required-method table transcribed from the inline table at prelude.js:168
// (verified 2026-11-17); the articles/auth/ui entries expand the `methods`
// references resolved at prelude.js:141. This is deliberately NOT the full
// collection table at prelude.js:141 — e.g. search only requires ["search"]
// and catalog only ["getCategories","list"]; judging by the full table would
// wrongly fail ~15 of the 21 existing plugins that legally implement only
// search.search.
export const REQUIRED_METHODS = {
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
};

// `api` requires whitelist transcribed from the host requirements() check in
// manager.rs (~lines 243-271, verified 2026-11-17). `feature` requires are
// limited to charset.legacy by the same match arm.
const API_REQUIRES = new Set([
  'http.fetch',
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.clear',
  'storage.keys',
  'cookies.get',
  'cookies.set',
  'cookies.clear',
  'html.parse',
  'crypto.digest',
  'crypto.hmac',
  'crypto.aesEncrypt',
  'crypto.aesDecrypt',
  'crypto.rsaEncrypt',
  'crypto.randomBytes',
  'crypto.randomUUID',
  'codec.base64Encode',
  'codec.base64Decode',
  'codec.hexEncode',
  'codec.hexDecode',
  'codec.utf8Encode',
  'codec.utf8Decode',
  'codec.decodeText',
  'settings.get',
  'settings.getAll',
  'endpoint.url',
]);
const FEATURE_REQUIRES = new Set(['charset.legacy']);

// Timeout budget keys used by the host Meta::budget dispatch (model.rs).
const TIMEOUT_KEYS = new Set(['read', 'playback', 'login', 'transform']);
const SETTING_TYPES = new Set(['text', 'password', 'switch', 'number', 'select']);
// prelude.js:176 — entry-point capabilities that require media.getDetail.
const GATE_METHODS = ['home.getSections', 'catalog.list', 'search.search', 'feed.list', 'library.listMedia'];
const MAX_U53 = Number.MAX_SAFE_INTEGER; // host version() bound: 2^53-1 (model.rs:51-71)

// Rust chars().count() alignment for length caps.
const cpLen = (s) => [...s].length;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const joinProblems = (parts) => (parts.length ? parts.join('; ') : undefined);

// Shared with validate.mjs (single source of truth for stem/id semantics).
export function fileStem(fileName) {
  const name = typeof fileName === 'string' ? fileName : '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// meta-01 [host model.rs:73-75] — declared field types match PluginMeta.
// Unknown fields are ignored (serde default).
function meta01(meta) {
  const p = [];
  for (const key of ['id', 'name', 'version']) {
    if (typeof meta[key] !== 'string') p.push(`${key} 必须为字符串`);
  }
  if (!Number.isInteger(meta.protocol) || meta.protocol < 0 || meta.protocol > 0xffffffff) {
    p.push('protocol 必须为非负整数');
  }
  for (const key of ['kind', 'description', 'author']) {
    if (meta[key] !== undefined && typeof meta[key] !== 'string') p.push(`${key} 必须为字符串`);
  }
  for (const key of ['homepage', 'updateUrl']) {
    if (meta[key] !== undefined && meta[key] !== null && typeof meta[key] !== 'string') {
      p.push(`${key} 必须为字符串或 null`);
    }
  }
  for (const key of ['matches', 'linkDomains', 'features']) {
    const v = meta[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
      p.push(`${key} 必须为字符串数组`);
    }
  }
  if (meta.defaultHeaders !== undefined && !isPlainObject(meta.defaultHeaders)) {
    p.push('defaultHeaders 必须为对象');
  }
  if (meta.timeouts !== undefined && !isPlainObject(meta.timeouts)) {
    p.push('timeouts 必须为对象');
  } else if (isPlainObject(meta.timeouts)) {
    for (const [k, v] of Object.entries(meta.timeouts)) {
      if (typeof v !== 'number') p.push(`timeouts.${k} 必须为数值`);
    }
  }
  if (meta.requires !== undefined && (!Array.isArray(meta.requires) || meta.requires.some((r) => !isPlainObject(r) || typeof r.type !== 'string' || typeof r.name !== 'string'))) {
    p.push('requires 项必须为含 type/name 字符串的对象');
  }
  for (const key of ['allowInsecureHttp', 'mature']) {
    if (meta[key] !== undefined && typeof meta[key] !== 'boolean') p.push(`${key} 必须为布尔值`);
  }
  if (meta.settings !== undefined && !Array.isArray(meta.settings)) p.push('settings 必须为数组');
  return joinProblems(p);
}

// meta-02 [host model.rs:76-101] — id format.
function meta02(meta) {
  const id = meta.id;
  if (typeof id !== 'string') return undefined; // 类型问题归 meta-01
  const p = [];
  if (id === '') {
    p.push('id 不能为空');
  } else {
    const bytes = new TextEncoder().encode(id).length; // host: id.as_bytes().len()
    if (bytes > 64) p.push(`id 长度 ${bytes} 字节超过 64`);
    if (!/^[a-z0-9]/.test(id)) p.push('id 首字符必须为小写字母或数字');
    if (!/^[a-z0-9._-]+$/.test(id)) p.push('id 字符集必须为 [a-z0-9._-]');
    const stem = id.split('.')[0].toUpperCase();
    const reserved = ['CON', 'PRN', 'AUX', 'NUL'].includes(stem)
      || (stem.length === 4 && /^(COM|LPT)/.test(stem) && /^[0-9]$/.test(stem[3]));
    if (reserved) p.push(`id 使用了 Windows 保留名 ${stem}`);
    if (id.endsWith('.')) p.push('id 不能以 . 结尾');
  }
  return joinProblems(p);
}

// meta-03 [repo invariant] — id equals the file stem and is unique in the repo.
function meta03(dump, ctx) {
  const id = dump.meta.id;
  const p = [];
  if (typeof id !== 'string' || id === '') {
    p.push('id 不能为空');
  } else {
    const stem = fileStem(dump.fileName);
    if (id !== stem) p.push(`id 必须等于文件名去扩展名（期望 "${stem}"）`);
    if (ctx && ctx.idCounts && typeof ctx.idCounts.get === 'function' && ctx.idCounts.get(id) > 1) {
      p.push(`id 在仓库内重复（${ctx.idCounts.get(id)} 处）`);
    }
  }
  return joinProblems(p);
}

// meta-04 [host model.rs:51-71] — version format.
function meta04(meta) {
  const v = meta.version;
  if (typeof v !== 'string') return undefined;
  const parts = v.split('.');
  const ok = parts.length === 3 && parts.every((s) =>
    s.length > 0 && !(s.length > 1 && s[0] === '0') && /^[0-9]+$/.test(s) && Number(s) <= MAX_U53);
  return ok ? undefined : `version "${v}" 必须为三段数字、无前导零、各段 ≤ 2^53-1`;
}

// meta-05 [host model.rs:96-98] — name/description lengths in code points.
function meta05(meta) {
  const p = [];
  if (typeof meta.name === 'string') {
    if (meta.name.trim() === '') p.push('name 不能为空白');
    if (cpLen(meta.name) > 60) p.push(`name 长度 ${cpLen(meta.name)} 码点超过 60`);
  }
  if (typeof meta.description === 'string' && cpLen(meta.description) > 500) {
    p.push(`description 长度 ${cpLen(meta.description)} 码点超过 500`);
  }
  return joinProblems(p);
}

// meta-06 [host model.rs:103] — protocol major version.
function meta06(meta) {
  if (typeof meta.protocol !== 'number') return undefined; // 类型问题归 meta-01
  return meta.protocol === 1 ? undefined : `protocol 必须为 1（当前 ${meta.protocol}）`;
}

// meta-07 [type + host model.rs:106-109] — kind enum; resolver needs matches.
// A missing matches field serde-defaults to an empty vec (model.rs:24), which
// the host rejects for resolvers, so absent and empty are the same FAIL shape;
// a non-array, non-undefined matches stays meta-01's shape violation.
function meta07(meta) {
  if (meta.kind !== undefined && typeof meta.kind !== 'string') return undefined; // 类型问题归 meta-01
  const kind = meta.kind === undefined ? 'source' : meta.kind; // 宿主 serde 缺省 source
  const p = [];
  if (kind !== 'source' && kind !== 'resolver') p.push(`kind "${kind}" 必须为 source 或 resolver`);
  if (kind === 'resolver'
    && (meta.matches === undefined || (Array.isArray(meta.matches) && meta.matches.length === 0))) {
    p.push('resolver 必须声明非空 matches');
  }
  return joinProblems(p);
}

// host model.rs validate_setting — default value must match the setting type.
function validSettingDefault(s) {
  switch (s.type) {
    case 'text':
    case 'password':
      return typeof s.default === 'string';
    case 'switch':
      return typeof s.default === 'boolean';
    case 'number': {
      const v = s.default;
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      if (typeof s.min === 'number' && v < s.min) return false;
      if (typeof s.max === 'number' && v > s.max) return false;
      return true;
    }
    case 'select':
      return typeof s.default === 'string' && Array.isArray(s.options)
        && s.options.some((o) => isPlainObject(o) && o.value === s.default);
    default:
      return false;
  }
}

// meta-09 [host model.rs:111-129 + validate_setting] — settings shape.
function meta09(meta) {
  if (!Array.isArray(meta.settings)) return undefined;
  const p = [];
  const seen = new Set();
  meta.settings.forEach((raw, i) => {
    const s = isPlainObject(raw) ? raw : null;
    const key = s && typeof s.key === 'string' ? s.key : '';
    if (key === '') p.push(`settings[${i}] 缺少非空 key`);
    else if (seen.has(key)) p.push(`settings[${i}] key "${key}" 重复`);
    else seen.add(key);
    if (!s || typeof s.label !== 'string') p.push(`settings[${i}] 缺少 label 字符串`);
    const type = s ? s.type : undefined;
    if (!SETTING_TYPES.has(type)) {
      p.push(`settings[${i}] type "${type}" 必须为 text/password/switch/number/select`);
    }
    if (type === 'select' && (!Array.isArray(s.options) || s.options.length === 0)) {
      p.push(`settings[${i}] select 必须有非空 options`);
    }
    if (s && s.default !== undefined && !validSettingDefault(s)) {
      p.push(`settings[${i}] default 与 type 不匹配`);
    }
  });
  return joinProblems(p);
}

// meta-10 [stricter than host] — positive timeout values with known keys.
// The host only checks is_finite (model.rs:130-134).
function meta10(meta) {
  if (!isPlainObject(meta.timeouts)) return undefined;
  const p = [];
  for (const [k, v] of Object.entries(meta.timeouts)) {
    if (typeof v !== 'number') continue; // 类型问题归 meta-01
    if (!(v > 0)) p.push(`timeouts.${k} 必须为正数`);
  }
  for (const k of Object.keys(meta.timeouts)) {
    if (!TIMEOUT_KEYS.has(k)) p.push(`timeouts 键 "${k}" 不在 read/playback/login/transform 内`);
  }
  return joinProblems(p);
}

// meta-11 [stricter than host] — domain pattern, header values, labels.
function meta11(meta) {
  const p = [];
  for (const key of ['matches', 'linkDomains']) {
    if (!Array.isArray(meta[key])) continue;
    for (const item of meta[key]) {
      if (typeof item === 'string' && !/^[a-z0-9.-]+$/.test(item)) {
        p.push(`${key} 项 "${item}" 必须匹配 ^[a-z0-9.-]+$`);
      }
    }
  }
  if (isPlainObject(meta.defaultHeaders)) {
    for (const [k, v] of Object.entries(meta.defaultHeaders)) {
      if (typeof v !== 'string') p.push(`defaultHeaders.${k} 值必须为字符串`);
    }
  }
  if (Array.isArray(meta.settings)) {
    meta.settings.forEach((s, i) => {
      if (isPlainObject(s) && typeof s.label === 'string' && s.label.trim() === '') {
        p.push(`settings[${i}] label 不能为空`);
      }
    });
  }
  return joinProblems(p);
}

// meta-12 [host manager.rs requirements()] — requires entries.
function meta12(meta) {
  if (!Array.isArray(meta.requires)) return undefined;
  const p = [];
  meta.requires.forEach((r, i) => {
    if (!isPlainObject(r) || typeof r.type !== 'string' || typeof r.name !== 'string') return; // 形状问题归 meta-01
    if (r.type === 'feature') {
      if (!FEATURE_REQUIRES.has(r.name)) p.push(`requires[${i}] feature "${r.name}" 不受支持（仅 charset.legacy）`);
    } else if (r.type === 'api') {
      if (!API_REQUIRES.has(r.name)) p.push(`requires[${i}] api "${r.name}" 不在宿主白名单内`);
    } else {
      p.push(`requires[${i}] type "${r.type}" 必须为 feature 或 api`);
    }
  });
  return joinProblems(p);
}

function capabilitiesOf(dump) {
  return isPlainObject(dump.capabilities) ? dump.capabilities : {};
}
const hasCap = (caps, key) => caps[key] === true; // 只认 === true（信封能力表约定）
const hasNamespace = (caps, ns) => Object.entries(caps).some(([k, v]) => v === true && k.startsWith(ns + '.'));

// Host serde default: a missing kind means "source".
const effectiveKind = (meta) => (meta.kind === undefined ? 'source' : meta.kind);

// cap-01 [host prelude.js:165-166] — factory must return a non-empty object.
// The envelope cannot distinguish a non-object return from an object without
// functions; both produce zero capability keys and both are host rejections.
function cap01(dump) {
  const caps = capabilitiesOf(dump);
  return Object.values(caps).some((v) => v === true)
    ? undefined
    : '工厂返回值未产生任何能力（宿主要求非空对象）';
}

// cap-02 [host prelude.js:175] — a source must implement media.* or live.resolve.
function cap02(dump) {
  if (effectiveKind(dump.meta) === 'resolver') return undefined;
  const caps = capabilitiesOf(dump);
  if (hasNamespace(caps, 'media') || hasCap(caps, 'live.resolve')) return undefined;
  return 'source 必须实现 media.* 或 live.resolve 之一';
}

// cap-03 [host prelude.js:168-171] — a namespace declared on the factory
// result (declaredNamespaces: one-level keys, any value type) whose
// name is in the required-method table must expose the full set as
// capabilities. A non-object or empty-object value yields no capabilities
// and fails here. Dumps without declaredNamespaces (hand-built) fall back to
// inferring the namespaces from capability keys (the
// declaredNamespaces-less fallback behaviour).
function cap03(dump) {
  const caps = capabilitiesOf(dump);
  const declared = Array.isArray(dump.declaredNamespaces)
    ? dump.declaredNamespaces.filter((ns) => typeof ns === 'string')
    : [...new Set(Object.keys(caps).filter((k) => caps[k] === true).map((k) => k.split('.')[0]))];
  const p = [];
  for (const ns of declared) {
    // Own-property lookup only: prototype-key names like 'hasOwnProperty'
    // or 'constructor' resolve to inherited functions on the table object
    // and would crash methods.filter below.
    const methods = Object.hasOwn(REQUIRED_METHODS, ns) ? REQUIRED_METHODS[ns] : undefined;
    if (!methods || methods.length === 0) continue;
    const missing = methods.filter((m) => !hasCap(caps, ns + '.' + m));
    if (missing.length) p.push(`${ns} 缺少必需方法 ${missing.join('/')}`);
  }
  return joinProblems(p);
}

// cap-04 [host prelude.js:176] — entry-point capabilities require media.getDetail.
function cap04(dump) {
  if (effectiveKind(dump.meta) === 'resolver') return undefined;
  const caps = capabilitiesOf(dump);
  if (hasCap(caps, 'media.getDetail')) return undefined;
  const hits = GATE_METHODS.filter((m) => hasCap(caps, m));
  if (!hits.length) return undefined;
  return `实现 ${hits.join('/')} 时必须同时实现 media.getDetail`;
}

// cap-05 [host prelude.js:174,177] — resolver kind requires resolver.resolve.
function cap05(dump) {
  if (effectiveKind(dump.meta) !== 'resolver') return undefined;
  if (hasCap(capabilitiesOf(dump), 'resolver.resolve')) return undefined;
  return 'resolver 类型必须实现 resolver.resolve';
}

// warn-01 [repo style policy] — kebab-case ids.
function warn01(meta) {
  const id = meta.id;
  if (typeof id !== 'string' || id === '') return undefined;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) ? undefined : `id "${id}" 不符合 kebab-case（仓库风格）`;
}

// warn-03 [repo style policy] — missing description/author.
function warn03(meta) {
  const p = [];
  for (const key of ['description', 'author']) {
    const v = meta[key];
    if (v === undefined || (typeof v === 'string' && v.trim() === '')) p.push(`${key} 缺失`);
  }
  return joinProblems(p);
}

// Rule table: meta-01..07, meta-09..12, cap-01..05, warn-01/warn-03.
// meta-08 / file-01 / dump-01 are main-process short-circuits outside
// checkPlugin. Each check returns one message (violations joined by '; ')
// or undefined.
const RULES = [
  { id: 'meta-01', severity: 'fail', check: (dump) => meta01(dump.meta) },
  { id: 'meta-02', severity: 'fail', check: (dump) => meta02(dump.meta) },
  { id: 'meta-03', severity: 'fail', check: (dump, ctx) => meta03(dump, ctx) },
  { id: 'meta-04', severity: 'fail', check: (dump) => meta04(dump.meta) },
  { id: 'meta-05', severity: 'fail', check: (dump) => meta05(dump.meta) },
  { id: 'meta-06', severity: 'fail', check: (dump) => meta06(dump.meta) },
  { id: 'meta-07', severity: 'fail', check: (dump) => meta07(dump.meta) },
  { id: 'meta-09', severity: 'fail', check: (dump) => meta09(dump.meta) },
  { id: 'meta-10', severity: 'fail', check: (dump) => meta10(dump.meta) },
  { id: 'meta-11', severity: 'fail', check: (dump) => meta11(dump.meta) },
  { id: 'meta-12', severity: 'fail', check: (dump) => meta12(dump.meta) },
  { id: 'cap-01', severity: 'fail', check: cap01 },
  { id: 'cap-02', severity: 'fail', check: cap02 },
  { id: 'cap-03', severity: 'fail', check: cap03 },
  { id: 'cap-04', severity: 'fail', check: cap04 },
  { id: 'cap-05', severity: 'fail', check: cap05 },
  { id: 'warn-01', severity: 'warn', check: (dump) => warn01(dump.meta) },
  { id: 'warn-03', severity: 'warn', check: (dump) => warn03(dump.meta) },
];

// checkPlugin(dump, ctx) → Finding[] where Finding =
// {rule, severity: "fail"|"warn", pluginId, message}. Only ok:true envelopes
// are processed; anything else is the CLI's short-circuit business.
export function checkPlugin(dump, ctx) {
  if (!isPlainObject(dump) || dump.ok !== true) return [];
  const meta = isPlainObject(dump.meta) ? dump.meta : {};
  const normalized = { ...dump, meta };
  const pluginId = typeof meta.id === 'string' && meta.id ? meta.id : fileStem(dump.fileName);
  const findings = [];
  for (const rule of RULES) {
    const problem = rule.check(normalized, ctx);
    if (problem) {
      findings.push({ rule: rule.id, severity: rule.severity, pluginId, message: `${rule.id} ${problem}` });
    }
  }
  return findings;
}

// parseEnvelope(stdoutText, pluginId) → the parsed envelope object, or a
// dump-01 finding when stdout is not exactly one JSON object.
export function parseEnvelope(stdoutText, pluginId) {
  if (typeof stdoutText === 'string') {
    try {
      const parsed = JSON.parse(stdoutText);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // fall through to the pollution finding
    }
  }
  return { rule: 'dump-01', severity: 'fail', pluginId, message: '输出被污染' };
}

// ---------------------------------------------------------------------------
// Subscription-list consistency (repo-side invariants — the host never
// reads subs/): list-01..04 + warn-02.
//
// checkLists is a pure function over already-parsed list objects. The CLI
// reads manifest.json / subs/{all,vod,18}.json and passes each parsed object
// or null for a missing OR unparsable file — the two null causes are
// indistinguishable here, so a null list simply skips every rule that needs
// it, and the caller reports JSON parse failures itself as list-04 with the
// file name. dumps maps pluginId → ok:true envelope (short-circuited plugins
// are absent); fileNames is the full set of plugin file stems including the
// short-circuited ones (list-01 counts them too).
//
// Attribution: repo-level invariants name their list file as pluginId
// (list-01 → manifest.json, list-02/list-04 → subs/all.json); list-03 and
// warn-02 name the plugin id they are about.
// ---------------------------------------------------------------------------

// list-03 applies to every list independently; the label names the offending
// list in messages. Keys mirror the checkLists `lists` argument. Exported for
// validate.mjs (single source of truth for list file paths).
export const LIST_FILES = [
  ['manifest', 'manifest.json'],
  ['all', 'subs/all.json'],
  ['vod', 'subs/vod.json'],
  ['nsfw18', 'subs/18.json'],
];

const okDump = (dump) => (isPlainObject(dump) && dump.ok === true ? dump : undefined);
const metaOf = (dump) => (isPlainObject(dump.meta) ? dump.meta : {});

// Entries with a usable string id; other entry shapes have no id to compare
// and are left to the id-set rules and the caller's parse-failure finding.
function listEntries(list) {
  if (!isPlainObject(list) || !Array.isArray(list.plugins)) return [];
  return list.plugins.filter((e) => isPlainObject(e) && typeof e.id === 'string' && e.id !== '');
}
const idSet = (entries) => new Set(entries.map((e) => e.id));

// list-01 [repo invariant] — manifest id set === plugins/*.js file stems.
function list01(manifest, fileNames) {
  if (!isPlainObject(manifest) || fileNames === undefined || fileNames === null) return undefined;
  const ids = idSet(listEntries(manifest));
  const files = new Set(fileNames);
  const p = [];
  const noFile = [...ids].filter((id) => !files.has(id));
  const noEntry = [...files].filter((stem) => !ids.has(stem));
  if (noFile.length) p.push(`manifest 条目缺少插件文件: ${noFile.join(', ')}`);
  if (noEntry.length) p.push(`插件文件未收录进 manifest: ${noEntry.join(', ')}`);
  return joinProblems(p);
}

// list-02 [repo invariant] — all.json id set === manifest id set (build-subs.mjs
// writes both files from the same source array, so any drift is hand-editing).
function list02(manifest, all) {
  if (!isPlainObject(manifest) || !isPlainObject(all)) return undefined;
  const mIds = idSet(listEntries(manifest));
  const aIds = idSet(listEntries(all));
  const p = [];
  const onlyAll = [...aIds].filter((id) => !mIds.has(id));
  const onlyManifest = [...mIds].filter((id) => !aIds.has(id));
  if (onlyAll.length) p.push(`仅在 subs/all.json: ${onlyAll.join(', ')}`);
  if (onlyManifest.length) p.push(`仅在 manifest.json: ${onlyManifest.join(', ')}`);
  return joinProblems(p);
}

// list-03 [repo invariant] — entry name/version match the plugin meta and url is
// exactly plugins/<id>.js; description is exempt (regex-extracted by
// build-subs.mjs). Ill-typed meta values stay meta-01's shape business, and
// entries without an ok dump are skipped: their membership is already
// list-01/02/04 business.
function list03Problems(entry, dump, file) {
  const p = [];
  if (entry.url !== `plugins/${entry.id}.js`) {
    p.push(`${file} url "${entry.url}" 必须为 "plugins/${entry.id}.js"`);
  }
  if (dump) {
    const meta = metaOf(dump);
    if (typeof meta.name === 'string' && entry.name !== meta.name) {
      p.push(`${file} name "${entry.name}" 与插件 meta "${meta.name}" 不一致`);
    }
    if (typeof meta.version === 'string' && entry.version !== meta.version) {
      p.push(`${file} version "${entry.version}" 与插件 meta "${meta.version}" 不一致`);
    }
  }
  return joinProblems(p);
}

// list-04 [repo invariant] — vod∩18 = ∅ and vod∪18 = all (the mature partition of
// all.json). Needs all three lists.
function list04(all, vod, nsfw18) {
  if (!isPlainObject(all) || !isPlainObject(vod) || !isPlainObject(nsfw18)) return undefined;
  const allIds = idSet(listEntries(all));
  const vodIds = idSet(listEntries(vod));
  const nsfwIds = idSet(listEntries(nsfw18));
  const p = [];
  const overlap = [...vodIds].filter((id) => nsfwIds.has(id));
  if (overlap.length) p.push(`vod 与 18 重叠: ${overlap.join(', ')}`);
  const union = new Set([...vodIds, ...nsfwIds]);
  const uncovered = [...allIds].filter((id) => !union.has(id));
  const extra = [...union].filter((id) => !allIds.has(id));
  if (uncovered.length) p.push(`all 条目未被 vod∪18 覆盖: ${uncovered.join(', ')}`);
  if (extra.length) p.push(`vod∪18 条目不在 all 内: ${extra.join(', ')}`);
  return joinProblems(p);
}

// warn-02 [repo invariant] — mature flag vs 18.json membership, both directions.
// The meta field is authoritative; the fix is rerunning build-subs.mjs.
// Returns [pluginId, problem] pairs.
function warn02(nsfw18, dumps) {
  if (!isPlainObject(nsfw18)) return [];
  const nsfwIds = idSet(listEntries(nsfw18));
  const hits = [];
  for (const [key, raw] of dumps) {
    const dump = okDump(raw);
    if (!dump) continue;
    const meta = metaOf(dump);
    const id = typeof meta.id === 'string' && meta.id ? meta.id : key;
    if (meta.mature === true && !nsfwIds.has(id)) {
      hits.push([id, 'mature:true 但未收录进 subs/18.json（以 mature 字段为准，请重跑 node scripts/build-subs.mjs）']);
    } else if (meta.mature !== true && nsfwIds.has(id)) {
      hits.push([id, '未标记 mature:true 但收录进 subs/18.json（以 mature 字段为准，请重跑 node scripts/build-subs.mjs）']);
    }
  }
  return hits;
}

// checkLists(lists, dumps, fileNames) → Finding[] for the list-consistency rules,
// same Finding shape as checkPlugin. `lists` values of null (missing or
// unparsable file) skip the rules that consume them; a null `fileNames`
// skips list-01 (no full file scan available).
export function checkLists(lists, dumps, fileNames) {
  const l = isPlainObject(lists) ? lists : {};
  const dumpMap = dumps instanceof Map ? dumps : new Map();
  const findings = [];
  const add = (rule, severity, pluginId, problem) => {
    findings.push({ rule, severity, pluginId, message: `${rule} ${problem}` });
  };

  const p01 = list01(l.manifest, fileNames);
  if (p01) add('list-01', 'fail', 'manifest.json', p01);
  const p02 = list02(l.manifest, l.all);
  if (p02) add('list-02', 'fail', 'subs/all.json', p02);

  for (const [key, file] of LIST_FILES) {
    const list = l[key];
    if (!isPlainObject(list)) continue;
    for (const entry of listEntries(list)) {
      const problems = list03Problems(entry, okDump(dumpMap.get(entry.id)), file);
      if (problems) add('list-03', 'fail', entry.id, problems);
    }
  }

  const p04 = list04(l.all, l.vod, l.nsfw18);
  if (p04) add('list-04', 'fail', 'subs/all.json', p04);

  for (const [id, problem] of warn02(l.nsfw18, dumpMap)) add('warn-02', 'warn', id, problem);
  return findings;
}
