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
import { checkLists, checkPlugin, parseEnvelope } from './rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const metaDumpPath = path.join(here, 'meta-dump.mjs');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024; // file-01 host cap (spec §5)
const CHUNK_SIZE = 4; // pinned concurrency: chunked Promise.all, no worker pool
const STDERR_EXCERPT_CP = 200; // stderr excerpt cap in code points

// Keys mirror the checkLists `lists` argument (rules.mjs LIST_FILES).
const LIST_FILES = [
  ['manifest', 'manifest.json'],
  ['all', 'subs/all.json'],
  ['vod', 'subs/vod.json'],
  ['nsfw18', 'subs/18.json'],
];

function fileStem(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

// Finding shape aligned with rules.mjs: message carries the "rule " prefix.
function finding(rule, severity, pluginId, message) {
  return { rule, severity, pluginId, message: `${rule} ${message}` };
}

// Code-point-aware truncation (Rust chars().count() alignment, spec §9).
function cpTruncate(s, maxCp) {
  const cps = [...s];
  return cps.length <= maxCp ? s : cps.slice(0, maxCp).join('') + '…';
}

function stderrExcerpt(stderr) {
  const oneLine = stderr.trim().split(/\r?\n/).filter(Boolean).join(' | ');
  return oneLine ? `；stderr 摘要：${cpTruncate(oneLine, STDERR_EXCERPT_CP)}` : '';
}

// Spawn one meta-dump worker. On timeout the child is killed and the promise
// still resolves only after the 'exit' event — never from the kill() call
// itself — so the recorded state is the post-mortem truth.
function spawnDump(absPath, timeout) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [metaDumpPath, absPath], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
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
  if (raw.timedOut) {
    return [finding('dump-01', 'fail', stem, `执行超时（>${timeout}ms），已终止${stderrExcerpt(raw.stderr)}`)];
  }
  if (raw.code !== 0) {
    return [finding('dump-01', 'fail', stem, `meta-dump 异常退出（code ${raw.code}）${stderrExcerpt(raw.stderr)}`)];
  }
  if (envelope.rule === 'dump-01') {
    return [envelope]; // stdout polluted — parseEnvelope already built it
  }
  if (envelope.ok === true) {
    return checkPlugin({ ...envelope, fileName, fileSize: size }, ctx);
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
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return fail(`错误：--timeout 必须为正整数毫秒数（当前 ${timeout}）`);
  }

  const pluginsDir = path.join(root, 'plugins');
  let fileNames;
  try {
    fileNames = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
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
    const size = statSync(absPath).size;
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
    // exists (3a handoff ②: no fine-grained switch, accepted).
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
  // list findings after plugin lines, summary line last. Plain text — ANSI
  // colouring is the CLI shell's business (no TTY here).
  const statusOf = { fail: 'FAIL', warn: 'WARN' };
  const desc = (f) => (f.message.startsWith(f.rule + ' ') ? f.message.slice(f.rule.length + 1) : f.message);
  const lineOf = (f) => `${statusOf[f.severity] || 'FAIL'} ${f.pluginId} — [${f.rule}] ${desc(f)}`;

  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;
  for (const fileName of targets) {
    const findings = findingsByFile.get(fileName) || [];
    if (findings.length === 0) {
      lines.push(`PASS ${fileStem(fileName)}`);
      passCount += 1;
      continue;
    }
    for (const f of findings) {
      if (f.severity === 'warn') warnCount += 1; else failCount += 1;
      lines.push(lineOf(f));
    }
  }
  for (const f of listFindings) {
    if (f.severity === 'warn') warnCount += 1; else failCount += 1;
    lines.push(lineOf(f));
  }
  lines.push(`校验完成：${targets.length} 个插件：${passCount} 通过，${failCount} 失败，${warnCount} 警告`);
  return { exitCode: failCount > 0 ? 1 : 0, lines };
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
    if (!/^[1-9][0-9]*$/.test(opts.timeout)) {
      process.stderr.write(`错误：--timeout 必须为正整数毫秒数（当前 ${opts.timeout}）\n`);
      process.exitCode = 2;
      return;
    }
    timeout = Number(opts.timeout);
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
