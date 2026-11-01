import { loadSettings, syncFromCloud } from './lib/store.js';
import { translateTexts, visionOcrTranslate, VISION_ENGINES } from './lib/engines.js';
import { maskAll } from './lib/privacy.js';
import { AI_ENGINES, SECRET_FIELDS } from './lib/defaults.js';
import { nativeSend } from './lib/native.js';
import { cacheKey, readCache, writeCache, clearCache, cacheStats } from './lib/cache.js';
import { resolveGlossary, glossarySalt, protectGlossary } from './lib/glossary.js';

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

// Prime the cache as soon as the service worker starts.
refreshSecrets();

// Pull settings from iCloud so a change made on another device is picked up.
// Writes the newer copy locally; content scripts reload via storage.onChanged.
syncFromCloud().catch(() => {});

function protectLayout(text) {
  const markers = [];
  const protectedText = String(text).replace(/\r\n|\r|\n|\t/g, whitespace => {
    const index = markers.length;
    markers.push(whitespace);
    return `\uE000OT_WS_${index}\uE001`;
  });
  return {
    text: protectedText,
    restore(value) {
      return String(value || '').replace(/\uE000OT_WS_(\d+)\uE001/g, (_, index) => markers[Number(index)] || '');
    }
  };
}

/** Anything that changes the meaning of a translation without changing the text. */
function promptSalt(settings, engine) {
  if (!AI_ENGINES.includes(engine)) return '';
  return `${settings.ai.prompt || ''}\u0000${settings.ai.temperature}`;
}

async function handleTranslate({ texts = [], engine, source, target }, snapshot, skipCache = false) {
  const settings = snapshot || await loadSettings();
  await ensureSecrets();
  const useEngine = engine || settings.engine;
  const to = target || settings.targetLanguage;
  const from = source || settings.sourceLanguage || 'auto';
  const config = { ...(settings.engines[useEngine] || {}) };
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

  return results;
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
