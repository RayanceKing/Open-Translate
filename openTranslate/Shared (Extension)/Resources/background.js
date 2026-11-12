import { loadSettings, syncFromCloud } from './lib/store.js';
import {
  translateTexts,
  visionOcrTranslate,
  VISION_ENGINES,
  detectModels,
  installIndexTranslateHeaderRule,
  setNativeHttpTransport
} from './lib/engines.js';
import { maskAll } from './lib/privacy.js';
import { AI_ENGINES, SECRET_FIELDS } from './lib/defaults.js';
import { nativeSend, sendViaNativeApp as nativeHttpRequest } from './lib/native.js';
import { cacheKey, readCache, writeCache, clearCache, cacheStats } from './lib/cache.js';
import { resolveGlossary, glossarySalt, protectGlossary } from './lib/glossary.js';

// -------------------------------------------------------------------------
// Native HTTP relay (Safari only)
//
// iOS/iPadOS cannot push a message from the native app into a Safari extension,
// so every exchange is strict request/reply: the background page calls
// runtime.sendNativeMessage first, and SafariWebExtensionHandler answers via an
// NSExtensionItem. Only the background page may call sendNativeMessage, so the
// provider layer receives this function through dependency injection.
// -------------------------------------------------------------------------
const NATIVE_FORWARD_HOST = 'index-translate.bilibili.com';

async function sendViaNativeApp(payload) {
  // Second line of defence: engines.js already scopes the relay to the Index
  // host, but the native relay must never become a general-purpose open proxy.
  let host = '';
  try { host = new URL(payload?.url || '').hostname.toLowerCase(); } catch {}
  if (host !== NATIVE_FORWARD_HOST) {
    throw new Error(`原生转发仅允许 ${NATIVE_FORWARD_HOST}`);
  }
  const started = Date.now();
  try {
    const reply = await nativeHttpRequest(payload);
    console.debug?.(`Open Translate: native HTTP ${reply.status} in ${Date.now() - started} ms`);
    return reply;
  } catch (error) {
    if (error?.otNative) throw error;
    const wrapped = new Error(`原生转发失败：${error?.message || '未知错误'}`);
    wrapped.otNative = true;
    wrapped.status = 0;
    throw wrapped;
  }
}

setNativeHttpTransport(sendViaNativeApp);

// Safari-only extension. API keys (secrets) live in the system Keychain and are
// reached through the native app extension (see SafariWebExtensionHandler). We
// keep an in-memory cache so each translation doesn't round-trip to the Keychain.
let secretCache = {};
let secretsLoaded = false;

async function refreshSecrets() {
  try {
    const reply = await nativeSend({ type: 'secret', action: 'get' });
    if (reply && reply.secrets) secretCache = reply.secrets;
  } catch (error) {
    console.warn('Open Translate: 加载密钥缓存失败。', error);
  }
}

async function ensureSecrets() {
  if (secretsLoaded) return;
  await refreshSecrets();
  secretsLoaded = true;
}

function protectLayout(text) {
  const markers = [];
  const protectedText = String(text).replace(/\r\n|\r|\n|\t/g, whitespace => {
    const index = markers.length;
    markers.push(whitespace);
    return `__OT_WS_${index}__`;
  });
  return {
    text: protectedText,
    restore(value) {
      // ASCII-only token: Safari's native Translation framework and machine
      // translation engines strip/mangle PUA control chars, which used to leave
      // bare "OT_WS_<n>" leaking into the output. \s* tolerates added spacing.
      return String(value || '').replace(/__\s*OT_WS\s*_\s*(\d+)\s*__/g, (_, index) => markers[Number(index)] || '');
    }
  };
}

// Defensive: purge stale layout markers left by older cached translations or by
// an engine that mangled the token (PUA delimiters / replacement glyphs / bare
// OT_WS_<n>). Keeps cached bad output from being rendered after the fix.
const STALE_LAYOUT_MARKER = /[\uE000-\uF8FF\uFFFD\uFFFC\u2261_]*\s*OT_WS\s*_\s*\d+\s*[\uE000-\uF8FF\uFFFD\uFFFC\u2261_]*/gi;
function stripStaleMarkers(value) {
  const text = String(value || '');
  if (!/ot_ws/i.test(text)) return text;
  return text.replace(STALE_LAYOUT_MARKER, '').replace(/[ \t]{2,}/g, ' ');
}

/** Anything that changes the meaning of a translation without changing the text. */
function promptSalt(settings, engine) {
  if (!AI_ENGINES.includes(engine)) return '';
  return `${settings.ai.prompt || ''}\u0000${settings.ai.temperature}`;
}

async function handleTranslate({ texts = [], engine, source, target }, snapshot, skipCache = false) {
  let settings = snapshot || await syncFromCloud();
  await ensureSecrets();
  settings = typeof structuredClone === 'function'
    ? structuredClone(settings)
    : JSON.parse(JSON.stringify(settings));
  for (const [engineId, field] of Object.entries(SECRET_FIELDS)) {
    if (secretCache[engineId]) {
      settings.engines[engineId] ??= {};
      settings.engines[engineId][field] = secretCache[engineId];
    }
  }
  const useEngine = engine || settings.engine;
  const to = target || settings.targetLanguage;
  const from = source || settings.sourceLanguage || 'auto';
  const config = { ...(settings.engines[useEngine] || {}), settings };
  const secretField = SECRET_FIELDS[useEngine];
  if (secretField && secretCache[useEngine]) config[secretField] = secretCache[useEngine];
  const isAI = AI_ENGINES.includes(useEngine);
  const entries = isAI || settings.glossary?.machineTranslation ? resolveGlossary(settings, to) : [];
  if (isAI) {
    config.prompt = settings.ai.prompt || '';
    config.glossaryEntries = entries;
    config.temperature = settings.ai.temperature;
  }
  const salt = promptSalt(settings, useEngine) + '\u0000' + glossarySalt(settings, to, isAI);
  const keys = texts.map(text => cacheKey({ engine: useEngine, target: to, source: from, salt, text }));
  const hits = skipCache ? new Map() : await readCache(keys);

  const results = new Array(texts.length);
  const pending = [];
  texts.forEach((text, index) => {
    const hit = hits.get(keys[index]);
    if (hit !== undefined) results[index] = hit;
    else pending.push({ text, index, key: keys[index] });
  });

  if (pending.length) {
    const layouts = pending.map(item => protectLayout(item.text));
    const original = layouts.map(layout => layout.text);
    const guard = settings.privacy.maskSensitive ? maskAll(original) : null;
    const masked = guard ? guard.safe : original;
    const protection = !isAI && settings.glossary?.enabled && settings.glossary?.machineTranslation
      ? protectGlossary(masked, entries) : null;
    const payload = protection ? protection.safe : masked;
    const translated = await translateTexts({ engine: useEngine, texts: payload, source: from, target: to, config });
    if (!Array.isArray(translated) || translated.length !== pending.length || translated.some(value => typeof value !== 'string')) {
      throw new Error('翻译服务返回的段落数量或格式不正确');
    }
    const fresh = [];
    for (let index = 0; index < translated.length; index += 1) {
      let value = translated[index];
      let valid = true;
      if (protection) {
        const restored = protection.restore(value, index);
        valid = restored.valid;
        value = restored.text;
        if (!valid) {
          const retry = await translateTexts({ engine: useEngine, texts: [masked[index]], source: from, target: to, config });
          if (!Array.isArray(retry) || retry.length !== 1 || typeof retry[0] !== 'string') throw new Error('翻译服务返回的段落数量或格式不正确');
          value = retry[0];
        }
      }
      const text = layouts[index].restore(guard ? guard.restore(value) : value);
      results[pending[index].index] = text;
      if (valid && text) fresh.push([pending[index].key, text]);
    }
    if (!skipCache) await writeCache(fresh);
  }

  return results.map(text => typeof text === 'string' ? stripStaleMarkers(text) : text);
}

async function handleTest({ engine }) {
  const settings = await loadSettings();
  const [sample] = await handleTranslate({
    engine: engine || settings.engine,
    texts: ['The quick brown fox jumps over the lazy dog.'],
    source: 'auto',
    target: settings.targetLanguage
  }, settings, true);
  return sample;
}

// Model discovery for AI services. Safari stores API keys in the system
// Keychain rather than in settings, so merge: stored settings → live form
// draft → Keychain secret (only when the draft left the key blank).
async function handleDetectModels({ engine, config: draft = {} }) {
  if (!AI_ENGINES.includes(engine)) throw new Error('该翻译服务不支持模型检测');
  const settings = await loadSettings();
  await ensureSecrets();
  const config = { ...(settings.engines[engine] || {}), ...(draft || {}) };
  const secretField = SECRET_FIELDS[engine];
  if (secretField && !String(config[secretField] || '').trim() && secretCache[engine]) {
    config[secretField] = secretCache[engine];
  }
  const models = await detectModels({ engine, config });
  return { models };
}

// Image OCR + translation for manga mode. The content script sends the image as
// a data URL; we hand it to a multimodal engine and return detected boxes.
async function handleTranslateImage({ image, engine, source, target }, snapshot) {
  const settings = snapshot || await loadSettings();
  await ensureSecrets();
  const useEngine = engine || settings.manga.engine;
  if (!VISION_ENGINES.includes(useEngine)) throw new Error(`该引擎不支持视觉翻译：${useEngine}`);
  const config = { ...(settings.engines[useEngine] || {}) };
  const secretField = SECRET_FIELDS[useEngine];
  if (secretField && secretCache[useEngine]) config[secretField] = secretCache[useEngine];
  config.temperature = settings.ai.temperature;
  const boxes = await visionOcrTranslate({
    engine: useEngine,
    image,
    source: source || settings.sourceLanguage || 'auto',
    target: target || settings.targetLanguage,
    config
  });
  return { boxes };
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const fail = error => respond({ error: error?.message || String(error) });

  if (message?.type === 'translate') {
    handleTranslate(message).then(texts => respond({ texts })).catch(fail);
    return true;
  }
  if (message?.type === 'translate-image') {
    handleTranslateImage(message).then(result => respond(result)).catch(fail);
    return true;
  }
  if (message?.type === 'test-engine') {
    handleTest(message).then(text => respond({ text })).catch(fail);
    return true;
  }
  if (message?.type === 'detect-models') {
    handleDetectModels(message).then(result => respond(result)).catch(fail);
    return true;
  }
  if (message?.type === 'cache-stats') {
    cacheStats().then(stats => respond(stats)).catch(fail);
    return true;
  }
  if (message?.type === 'clear-cache') {
    clearCache().then(() => respond({ ok: true })).catch(fail);
    return true;
  }
  if (message?.type === 'native') {
    const inner = message.message || {};
    nativeSend(inner)
      .then(reply => {
        if (inner.type === 'secret' && (inner.action === 'set' || inner.action === 'delete')) {
          refreshSecrets().catch(() => {});
        }
        respond(reply || {});
      })
      .catch(fail);
    return true;
  }
  // Diagnostics: exercise the native relay without running a translation.
  if (message?.type === 'native-http') {
    sendViaNativeApp(message.payload || {})
      .then(reply => respond({ ok: true, status: reply.status }))
      .catch(fail);
    return true;
  }
  if (message?.type === 'open-options') {
    const url = chrome.runtime.getURL('options.html');
    try { if (typeof chrome.tabs?.create === 'function') chrome.tabs.create({ url }); } catch {}
    respond({ ok: true });
    return false;
  }
  return false;
});

chrome.commands?.onCommand.addListener(async command => {
  if (command !== 'toggle-translation') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  // Best-effort fix for the B站 WAF's HTTP 412 on extension-origin requests.
  // Safari may ignore modifyHeaders on extension-initiated fetches; the 412
  // hint in lib/engines.js then guides users to the local bridge proxy.
  installIndexTranslateHeaderRule().catch(() => {});
  try {
    chrome.contextMenus.create({ id: 'ot-translate-selection', title: '翻译选中文本', contexts: ['selection'] });
  } catch {
    /* menu may already exist after an update */
  }
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ot-translate-selection' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'translate-selection' }).catch(() => {});
  }
});
