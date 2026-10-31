// Session-scoped translation cache.
//
// Two layers:
//   L1  an in-memory Map inside the service worker — instant, but MV3 workers
//       are torn down after ~30s idle, so it cannot be the only layer.
//   L2  chrome.storage.session — survives worker restarts, is kept in memory
//       (never written to disk) and is dropped when the browser closes.
//
// That combination is exactly the "temporary" scope we want: switching tabs or
// reloading a page costs nothing, while a fresh browser session starts clean.
// Entries additionally expire after TTL so a session that stays open for days
// cannot serve stale translations forever.
//
// Keys are fingerprints, not the source text: the cache never stores what the
// user was reading, only the translated result.

const STORAGE_KEY = 'ot-translation-cache';
const TTL = 12 * 60 * 60 * 1000;
const LIMIT = 2000;
const FLUSH_DELAY = 400;

const memory = new Map(); // key -> { v: translation, t: timestamp }
let hydrating = null;
let flushTimer = null;

const sessionArea = () => {
  try {
    return chrome.storage?.session;
  } catch {
    return undefined;
  }
};

/** 64-bit FNV-1a style fingerprint, base36. */
function fingerprint(input) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(36)}.${b.toString(36)}`;
}

/**
 * Build the cache key for one segment. `salt` carries anything that changes the
 * meaning of a translation without changing the text (AI prompt, glossary,
 * temperature) so editing the prompt cannot serve an old result.
 */
export function cacheKey({ engine, target, source = 'auto', salt = '', text }) {
  const scope = salt ? fingerprint(String(salt)) : '0';
  return `${engine}|${target}|${source}|${scope}|${fingerprint(String(text))}`;
}

async function load() {
  const area = sessionArea();
  if (!area) return;
  let stored;
  try {
    stored = await area.get(STORAGE_KEY);
  } catch {
    return; // storage.session unavailable (old browser) — stay memory-only
  }
  const entries = stored?.[STORAGE_KEY];
  if (!entries || typeof entries !== 'object') return;
  const now = Date.now();
  for (const [key, entry] of Object.entries(entries)) {
    // Never clobber something written while this read was in flight.
    if (memory.has(key)) continue;
    if (!entry || typeof entry.v !== 'string') continue;
    const at = Number(entry.t) || 0;
    if (now - at > TTL) continue;
    memory.set(key, { v: entry.v, t: at });
  }
}

/** Idempotent hydration, safe to call from several async paths at once. */
function hydrate() {
  if (!hydrating) hydrating = load();
  return hydrating;
}

/** Look up many keys at once; returns Map<key, translation>. Refreshes LRU order. */
export async function readCache(keys) {
  await hydrate();
  const hits = new Map();
  const now = Date.now();
  for (const key of keys) {
    const entry = memory.get(key);
    if (!entry) continue;
    if (now - entry.t > TTL) {
      memory.delete(key);
      continue;
    }
    memory.delete(key); // re-insert to move the entry to the young end
    memory.set(key, entry);
    hits.set(key, entry.v);
  }
  return hits;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, FLUSH_DELAY);
}

async function flush() {
  await hydrate(); // make sure a late first write merges instead of truncating
  const area = sessionArea();
  if (!area) return;
  const write = async () => {
    const payload = {};
    for (const [key, entry] of memory) payload[key] = entry;
    await area.set({ [STORAGE_KEY]: payload });
  };
  try {
    await write();
  } catch {
    // Quota exceeded — keep the newest half and try once more.
    const keys = [...memory.keys()];
    keys.slice(0, Math.ceil(keys.length / 2)).forEach(key => memory.delete(key));
    try {
      await write();
    } catch {
      /* give up silently: the in-memory layer still works */
    }
  }
}

/** Store translations. `entries` is an array of [key, translation]. */
export function writeCache(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const now = Date.now();
  for (const [key, value] of entries) {
    if (typeof value !== 'string' || !key) continue;
    memory.delete(key);
    memory.set(key, { v: value, t: now });
  }
  while (memory.size > LIMIT) memory.delete(memory.keys().next().value);
  scheduleFlush();
}

export async function clearCache() {
  memory.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const area = sessionArea();
  if (!area) return;
  try {
    await area.remove(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

export async function cacheStats() {
  await hydrate();
  return { count: memory.size, limit: LIMIT, ttl: TTL };
}
