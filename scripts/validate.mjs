// Plugin contract validator — CLI main process.
//
//   node scripts/validate.mjs [--plugin <id>] [--root <dir>] [--timeout <ms>] [--help]
//
// Pipeline: parse args → scan <root>/plugins/*.js → file-01 size gate →
// chunked Promise.all (chunk = 4) meta-dump spawns with timeout/kill →
// parseEnvelope → short-circuit or checkPlugin → checkLists → report lines
// and exit code. Zero npm dependencies; node: builtins only.
//
// Failure short-circuits owned here (never handed to checkPlugin, which only
// accepts ok:true envelopes):
//   file-01 — plugin file > 2MiB, rejected before spawn
//             (spec §5, host runtime.rs:277-280)
//   meta-08 — envelope ok:false, stage "import", message prefixed "exports:"
//   dump-01 — timeout (killed, stderr excerpt folded into the message),
//             non-zero meta-dump exit code, polluted stdout (via
//             parseEnvelope), ok:false stage "factory", other import errors

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLists, checkPlugin, parseEnvelope, LIST_FILES, fileStem } from './rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const metaDumpPath = path.join(here, 'meta-dump.mjs');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 2147483647; // Node clamps larger setTimeout delays to 1ms
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024; // file-01 host cap (spec §5)
const CHUNK_SIZE = 4; // pinned concurrency: chunked Promise.all, no worker pool
const STDERR_EXCERPT_CP = 200; // stderr excerpt cap in code points

// Output caps: a runaway plugin flooding the pipes must die long before its
// timeout or the parent's memory gives out. A legal envelope is one short
// JSON line, so the stdout cap is generous; stderr carries the redirected
// console noise. Character counts (post-decode) are close enough for caps.
const MAX_STDOUT_CHARS = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;

// Finding shape aligned with rules.mjs: message carries the "rule " prefix.
function finding(rule, severity, pluginId, message) {
  return { rule, severity, pluginId, message: `${rule} ${message}` };
}

// Code-point-aware truncation (Rust chars().count() alignment, spec §9).
function cpTruncate(s, maxCp) {
  const cps = [...s];
  return cps.length <= maxCp ? s : cps.slice(0, maxCp).join('') + '…';
}

// Strip C0/C1 control characters (incl. the ANSI ESC introducer and BEL)
// from text before it enters a report line; only printable text survives.
const stripControls = (s) => (typeof s === 'string'
  ? s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
  : s);

function stderrExcerpt(stderr) {
  const oneLine = stripControls(stderr).trim().split(/\r?\n/).filter(Boolean).join(' | ');
  return oneLine ? `；stderr 摘要：${cpTruncate(oneLine, STDERR_EXCERPT_CP)}` : '';
}

// Kill the worker's whole process tree. POSIX: workers run detached (own
// process group, pgid === pid), so killing -pid reaps grandchildren the
// plugin may have spawned. Windows has no process groups; taskkill /T walks
// the tree (spawned with array args, no shell).
function killTree(child) {
  if (process.platform === 'win32') {
    if (child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => { child.kill('SIGKILL'); }); // taskkill unavailable — best effort
    } else {
      child.kill('SIGKILL');
    }
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = the worker's group
    } catch {
      child.kill('SIGKILL'); // group already gone
    }
  } else {
    child.kill('SIGKILL');
  }
}

// Spawn one meta-dump worker. The promise resolves only after the 'exit'
// event — never from the kill itself — so the recorded state is the
// post-mortem truth. killReason marks why the tree was killed: 'timeout' or
// the stream whose cap was exceeded ('stdout' | 'stderr').
function spawnDump(absPath, timeout) {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(process.execPath, [metaDumpPath, absPath], {
      windowsHide: true,
      // POSIX: own process group so killTree can reap the whole tree. On
      // Windows `detached` only unhandles the console — keep it false there.
      detached: !isWindows,
    });
    let stdout = '';
    let stderr = '';
    let killReason = null;
    let settled = false;
    const stop = (reason) => {
      if (killReason) return;
      killReason = reason;
      killTree(child);
    };
    const timer = setTimeout(() => stop('timeout'), timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > MAX_STDOUT_CHARS) stop('stdout');
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > MAX_STDERR_CHARS) stop('stderr');
    });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, killReason });
    };
    child.on('error', (err) => settle({ code: null, spawnError: err }));
    child.on('exit', (code) => settle({ code, spawnError: undefined }));
  });
}

// Classify one worker result into Findings, or hand an ok:true envelope to
// checkPlugin. `envelope` is the parseEnvelope result (an envelope object or
// a dump-01 pollution finding).
function pluginFindings(fileName, size, raw, envelope, ctx, timeout) {
  const stem = fileStem(fileName);
  if (raw.spawnError) {
    return [finding('dump-01', 'fail', stem, `无法启动 meta-dump：${raw.spawnError.message}`)];
  }
  if (raw.killReason === 'timeout') {
    return [finding('dump-01', 'fail', stem, `执行超时（>${timeout}ms），已终止${stderrExcerpt(raw.stderr)}`)];
  }
  if (raw.killReason) {
    const cap = raw.killReason === 'stdout' ? MAX_STDOUT_CHARS : MAX_STDERR_CHARS;
    return [finding('dump-01', 'fail', stem, `输出超限（${raw.killReason} 超过 ${cap} 字符），已终止${stderrExcerpt(raw.stderr)}`)];
  }
  if (raw.code !== 0) {
    return [finding('dump-01', 'fail', stem, `meta-dump 异常退出（code ${raw.code}）${stderrExcerpt(raw.stderr)}`)];
  }
  if (envelope.rule === 'dump-01') {
    return [envelope]; // stdout polluted — parseEnvelope already built it
  }
  if (envelope.ok === true) {
    const findings = checkPlugin({ ...envelope, fileName, fileSize: size }, ctx);
    // meta-08 (spec §12 errata): the host requires exactly {meta, default}.
    // The worker's "exports:" failure envelope only covers missing meta /
    // missing-or-non-function default — extra exports reach this ok:true
    // path, so judge moduleExports here.
    const mod = envelope.moduleExports;
    const exportKeys = mod !== null && typeof mod === 'object' && !Array.isArray(mod)
      ? Object.keys(mod).sort()
      : [];
    if (exportKeys.join(',') !== 'default,meta') {
      findings.unshift(finding('meta-08', 'fail', stem,
        `导出结构不合法：模块导出键为 [${exportKeys.join(', ')}]，宿主要求恰好 {meta, default}`));
    }
    return findings;
  }
  // ok:false envelope — classify by stage (brief: exports: → meta-08).
  const stage = envelope.stage;
  const message = typeof envelope.message === 'string' ? envelope.message : '';
  if (stage === 'import' && message.startsWith('exports:')) {
    return [finding('meta-08', 'fail', stem, `导出结构不合法：${message}`)];
  }
  if (stage === 'factory') {
    return [finding('dump-01', 'fail', stem, `工厂执行失败：${message}`)];
  }
  return [finding('dump-01', 'fail', stem, `导入失败：${message}`)];
}

// Read the four list files. Missing → null (checkLists skips that list's
// rules); unparsable → null plus a list-04 finding naming the file (3a
// handoff: parse failures are the caller's business).
function readLists(root) {
  const lists = {};
  const parseFailures = [];
  for (const [key, rel] of LIST_FILES) {
    let text;
    try {
      text = readFileSync(path.join(root, rel), 'utf8');
    } catch {
      lists[key] = null;
      continue;
    }
    try {
      lists[key] = JSON.parse(text);
    } catch (err) {
      lists[key] = null;
      parseFailures.push(finding('list-04', 'fail', rel, `${rel} 不是合法 JSON：${err.message}`));
    }
  }
  return { lists, parseFailures };
}

// runValidate({root, plugin, timeout}) → {exitCode, lines[]}. Never calls
// process.exit and never prints — the CLI shell owns both. exitCode: 0 clean,
// 1 any FAIL finding, 2 environment/usage error carried in lines[0].
export async function runValidate({ root = repoRoot, plugin, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const lines = [];
  const fail = (message) => ({ exitCode: 2, lines: [message] });
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    return fail(`错误：--timeout 必须为 1 到 ${MAX_TIMEOUT_MS} 之间的整数毫秒数（当前 ${timeout}）`);
  }

  const pluginsDir = path.join(root, 'plugins');
  let fileNames;
  try {
    // Real .js files only: symlinks are excluded so a linked file can never
    // pass the id/file-stem invariants or execute via a second name.
    fileNames = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return fail(`错误：插件目录不存在或不可读：${pluginsDir}`);
  }

  let targets = fileNames;
  if (plugin !== undefined) {
    const fileName = `${plugin}.js`;
    if (!fileNames.includes(fileName)) {
      return fail(`错误：插件文件不存在：plugins/${fileName}`);
    }
    targets = [fileName];
  }

  // file-01 pre-spawn gate; survivors go to the chunked spawn phase.
  const results = new Map(); // fileName → {preFindings} | spawn result
  const toSpawn = [];
  for (const fileName of targets) {
    const absPath = path.join(pluginsDir, fileName);
    let size;
    try {
      size = statSync(absPath).size;
    } catch (err) {
      // TOCTOU: the file vanished between readdir and stat — a dump-01, not
      // a crash.
      results.set(fileName, {
        preFindings: [finding('dump-01', 'fail', fileStem(fileName), `文件无法读取：${err.message}`)],
      });
      continue;
    }
    if (size > MAX_PLUGIN_BYTES) {
      results.set(fileName, {
        preFindings: [finding('file-01', 'fail', fileStem(fileName),
          `文件大小 ${size} 字节超过上限 ${MAX_PLUGIN_BYTES} 字节（2MiB）`)],
      });
    } else {
      toSpawn.push({ fileName, absPath, size });
    }
  }

  for (let i = 0; i < toSpawn.length; i += CHUNK_SIZE) {
    await Promise.all(toSpawn.slice(i, i + CHUNK_SIZE).map(async (job) => {
      const raw = await spawnDump(job.absPath, timeout);
      const envelope = parseEnvelope(raw.stdout, fileStem(job.fileName));
      results.set(job.fileName, { ...raw, envelope, size: job.size });
    }));
  }

  // meta-03 needs repo-wide id counts, so count ok:true meta ids before any
  // checkPlugin run. Short-circuited plugins have no readable meta and thus
  // never contribute to (or collide in) the counts.
  const idCounts = new Map();
  for (const result of results.values()) {
    if (result.envelope && result.envelope.ok === true) {
      const id = result.envelope.meta && result.envelope.meta.id;
      if (typeof id === 'string' && id !== '') {
        idCounts.set(id, (idCounts.get(id) || 0) + 1);
      }
    }
  }
  const ctx = { idCounts };

  const findingsByFile = new Map();
  const dumps = new Map(); // file stem → merged ok:true dump, for checkLists
  for (const fileName of targets) {
    const result = results.get(fileName);
    let findings;
    if (result.preFindings) {
      findings = result.preFindings;
    } else {
      findings = pluginFindings(fileName, result.size, result, result.envelope, ctx, timeout);
      if (result.envelope.ok === true) dumps.set(fileStem(fileName), { ...result.envelope, fileName, fileSize: result.size });
    }
    findingsByFile.set(fileName, findings);
  }

  const { lists, parseFailures } = readLists(root);
  let listFindings = [];
  if (plugin === undefined) {
    // Whole-repo mode: full list consistency incl. global invariants.
    listFindings = checkLists(lists, dumps, new Set(targets.map(fileStem)));
  } else {
    // --plugin mode (spec §6): skip global invariants list-01/02/04; check
    // only this id's entries in the lists that exist. Entries are filtered
    // to the plugin id first so the url check cannot spill onto other ids;
    // each list is then passed alone (fileNames=null, other lists absent)
    // so only its list-03 can fire. warn-02 still judges when 18.json
    // exists (3a handoff ②: no fine-grained switch, accepted). List JSON
    // parse failures are ALWAYS reported (also in --plugin mode) — see
    // readLists, which appends the list-04 finding regardless of mode.
    for (const [key] of LIST_FILES) {
      const list = lists[key];
      if (list === null) continue;
      const filtered = {
        ...list,
        plugins: (Array.isArray(list.plugins) ? list.plugins : []).filter((e) => e && e.id === plugin),
      };
      listFindings.push(...checkLists({ [key]: filtered }, dumps, null));
    }
  }
  listFindings.push(...parseFailures);

  // Report: one PASS line per clean plugin, one FAIL/WARN line per finding,
  // list findings after plugin lines, summary line last. The summary counts
  // PLUGINS (a plugin with several findings is one failing plugin, not
  // several), list problems are tallied separately. Plain text — ANSI
  // colouring is the CLI shell's business (no TTY here).
  const statusOf = { fail: 'FAIL', warn: 'WARN' };
  // desc: strip the "rule " prefix rules.mjs bakes into messages, then strip
  // C0/C1 controls (ANSI ESC, BEL, ...) so plugin-controlled text can never
  // forge or garble the report lines.
  const desc = (f) => stripControls(
    f.message.startsWith(f.rule + ' ') ? f.message.slice(f.rule.length + 1) : f.message,
  );
  const lineOf = (f) => `${statusOf[f.severity] || 'FAIL'} ${f.pluginId} — [${f.rule}] ${desc(f)}`;

  let passPlugins = 0;
  let failPlugins = 0;
  let warnOnlyPlugins = 0;
  for (const fileName of targets) {
    const findings = findingsByFile.get(fileName) || [];
    if (findings.length === 0) {
      lines.push(`PASS ${fileStem(fileName)}`);
      passPlugins += 1;
      continue;
    }
    const hasFail = findings.some((f) => f.severity !== 'warn');
    if (hasFail) failPlugins += 1;
    else if (findings.some((f) => f.severity === 'warn')) warnOnlyPlugins += 1;
    for (const f of findings) {
      lines.push(lineOf(f));
    }
  }
  let listFailCount = 0;
  let listWarnCount = 0;
  for (const f of listFindings) {
    if (f.severity === 'warn') listWarnCount += 1; else listFailCount += 1;
    lines.push(lineOf(f));
  }
  let summary = `校验完成：${targets.length} 个插件：${passPlugins} 全通过，${failPlugins} 失败，${warnOnlyPlugins} 仅警告`;
  if (listFailCount + listWarnCount > 0) {
    summary += `；清单问题 ${listFailCount + listWarnCount} 项`;
  }
  lines.push(summary);
  return { exitCode: failPlugins > 0 || listFailCount > 0 ? 1 : 0, lines };
}

// ---------------------------------------------------------------------------
// CLI shell (runs only when executed directly, not when imported by tests)
// ---------------------------------------------------------------------------

const USAGE = `用法：node scripts/validate.mjs [--plugin <id>] [--root <dir>] [--timeout <ms>] [--help]

选项：
  --plugin <id>    只校验指定插件（plugins/<id>.js），清单仅校验该 id 的条目
  --root <dir>     仓库根目录（默认：本脚本所在仓库根）
  --timeout <ms>   单插件执行超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）
  --help           显示本帮助

报告：每个插件一行 PASS，或每个问题一行 FAIL/WARN <id> — [规则] 描述，末尾为统计。
注意：校验器会在子进程中执行插件代码（等同运行任意 JS），请只对可信来源运行。
退出码：0 无失败；1 存在 FAIL；2 参数或环境错误。`;

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      opts.help = true;
    } else if (arg === '--plugin' || arg === '--root' || arg === '--timeout') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`参数 ${arg} 缺少值`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

async function cliMain() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`错误：${err.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    process.exitCode = 0;
    return;
  }

  let timeout = DEFAULT_TIMEOUT_MS;
  if (opts.timeout !== undefined) {
    const n = Number(opts.timeout);
    // Positive integer capped at 2^31-1: Node clamps larger setTimeout
    // delays to 1ms, which would insta-kill every worker.
    if (!/^[0-9]+$/.test(opts.timeout) || n < 1 || n > MAX_TIMEOUT_MS) {
      process.stderr.write(`错误：--timeout 必须为 1 到 ${MAX_TIMEOUT_MS} 之间的整数毫秒数（当前 ${opts.timeout}）\n`);
      process.exitCode = 2;
      return;
    }
    timeout = n;
  }

  const { exitCode, lines } = await runValidate({ root: opts.root, plugin: opts.plugin, timeout });

  // ANSI colours only on a TTY (and unless NO_COLOR); plain text otherwise.
  const colour = process.stdout.isTTY && !process.env.NO_COLOR;
  const ANSI = { PASS: '\x1b[32m', FAIL: '\x1b[31m', WARN: '\x1b[33m' };
  const RESET = '\x1b[0m';
  for (const line of lines) {
    if (!colour) {
      process.stdout.write(line + '\n');
      continue;
    }
    const key = line.slice(0, line.indexOf(' '));
    process.stdout.write((ANSI[key] ? ANSI[key] + line + RESET : line) + '\n');
  }
  process.exitCode = exitCode;
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedScript && invokedScript === fileURLToPath(import.meta.url)) {
  await cliMain();
}
