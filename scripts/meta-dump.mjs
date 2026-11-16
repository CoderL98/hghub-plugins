// meta-dump worker: load one plugin in isolation and print a single-line JSON
// envelope on stdout describing its meta and factory capabilities.
//
//   node scripts/meta-dump.mjs <plugin-file>
//
// Envelope shapes (exit code is always 0; failures live inside the envelope):
//   success: {ok: true, meta, moduleExports, capabilities, declaredNamespaces}
//   failure: {ok: false, stage: "import" | "factory", message}
//
// Invalid export structure (meta not an object, default not a function) is
// reported at stage "import" with an "exports:"-prefixed message.

import { pathToFileURL } from 'node:url';
import { format } from 'node:util';

// 1) Hijack console.* to stderr BEFORE any plugin code can run, so stdout
// carries exactly one JSON line no matter how noisy the plugin is.
const writeStderr = process.stderr.write.bind(process.stderr);
for (const name of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']) {
  if (typeof console[name] === 'function') {
    console[name] = (...args) => {
      writeStderr(format(...args) + '\n');
    };
  }
}

function describeError(err) {
  const prefix = err && err.name ? err.name + ': ' : '';
  const detail = err && err.message ? err.message : String(err);
  return prefix + detail;
}

// Pinned stub shape: one Proxy per namespace, property accesses cached per
// name (same instance every time), apply/construct return the proxy itself.
// `then` resolves to undefined so awaiting any stub value never hangs, and
// settings.get/storage.get explicitly return undefined so plugins observe
// "no stored value" instead of a truthy stub during capability collection.
function createStub() {
  const cache = new Map();

  const stub = new Proxy(function stub() {}, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (!cache.has(prop)) {
        cache.set(prop, prop === 'settings' || prop === 'storage' ? createNamespace() : createStub());
      }
      return cache.get(prop);
    },
    apply() {
      return stub;
    },
    construct() {
      return stub;
    },
  });

  return stub;
}

function createNamespace() {
  const cache = new Map();

  const namespace = new Proxy(function namespace() {}, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (!cache.has(prop)) {
        cache.set(prop, prop === 'get' ? function () { return undefined; } : createStub());
      }
      return cache.get(prop);
    },
    apply() {
      return namespace;
    },
    construct() {
      return namespace;
    },
  });

  return namespace;
}

// Full two-level sweep of the factory's return value: every own function
// found one level deep becomes "ns.method": true. No method table filtering.
function collectCapabilities(returned) {
  const capabilities = {};
  if (returned === null || typeof returned !== 'object') return capabilities;
  for (const ns of Object.keys(returned)) {
    const group = returned[ns];
    if (group === null || typeof group !== 'object') continue;
    for (const method of Object.keys(group)) {
      if (typeof group[method] === 'function') {
        capabilities[ns + '.' + method] = true;
      }
    }
  }
  return capabilities;
}

function describeModuleExports(mod) {
  const described = {};
  for (const name of Object.keys(mod).sort()) {
    described[name] = typeof mod[name];
  }
  return described;
}

async function main() {
  const pluginPath = process.argv[2];
  if (!pluginPath || typeof pluginPath !== 'string') {
    return { ok: false, stage: 'import', message: 'missing plugin path argument' };
  }

  let mod;
  try {
    mod = await import(pathToFileURL(pluginPath).href);
  } catch (err) {
    return { ok: false, stage: 'import', message: describeError(err) };
  }

  if (mod.meta === null || typeof mod.meta !== 'object' || Array.isArray(mod.meta)) {
    return { ok: false, stage: 'import', message: 'exports: meta must be an exported object' };
  }
  if (typeof mod.default !== 'function') {
    return { ok: false, stage: 'import', message: 'exports: default must be an exported function' };
  }

  let returned;
  try {
    returned = await mod.default(createStub());
  } catch (err) {
    return { ok: false, stage: 'factory', message: describeError(err) };
  }

  return {
    ok: true,
    meta: mod.meta,
    moduleExports: describeModuleExports(mod),
    capabilities: collectCapabilities(returned),
    // spec §12: one-level key names of the factory result, regardless of
    // value type — a declared namespace with a non-object/empty value
    // collects no capabilities, so the declaration itself must survive.
    declaredNamespaces: returned !== null && typeof returned === 'object' ? Object.keys(returned) : [],
  };
}

try {
  const envelope = await main();
  process.stdout.write(JSON.stringify(envelope) + '\n');
} catch (err) {
  // Last-resort guard: still emit a valid single-line envelope, never a stack
  // trace on stdout and never a non-zero exit code.
  process.stdout.write(JSON.stringify({ ok: false, stage: 'import', message: describeError(err) }) + '\n');
}
