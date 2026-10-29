import { loadSettings } from './lib/store.js';
import { translateTexts } from './lib/engines.js';
import { maskAll } from './lib/privacy.js';
import { AI_ENGINES } from './lib/defaults.js';
import { cacheKey, readCache, writeCache, clearCache, cacheStats } from './lib/cache.js';

/** Anything that changes the meaning of a translation without changing the text. */
function promptSalt(settings, engine) {
  if (!AI_ENGINES.includes(engine)) return '';
  return `${settings.ai.prompt || ''}\u0000${settings.ai.glossary || ''}\u0000${settings.ai.temperature}`;
}

async function handleTranslate({ texts = [], engine, source, target }) {
  const settings = await loadSettings();
  const useEngine = engine || settings.engine;
  const to = target || settings.targetLanguage;
  const from = source || settings.sourceLanguage || 'auto';
  const config = { ...(settings.engines[useEngine] || {}) };
  if (AI_ENGINES.includes(useEngine)) {
    config.prompt = settings.ai.prompt || '';
    config.glossary = settings.ai.glossary || '';
    config.temperature = settings.ai.temperature;
  }
  const salt = promptSalt(settings, useEngine);
  const keys = texts.map(text => cacheKey({ engine: useEngine, target: to, source: from, salt, text }));
  const hits = await readCache(keys);

  const results = new Array(texts.length);
  const pending = [];
  texts.forEach((text, index) => {
    const hit = hits.get(keys[index]);
    if (hit !== undefined) results[index] = hit;
    else pending.push({ text, index, key: keys[index] });
  });

  if (pending.length) {
    const guard = settings.privacy.maskSensitive ? maskAll(pending.map(item => item.text)) : null;
    const payload = guard ? guard.safe : pending.map(item => item.text);
    const translated = await translateTexts({ engine: useEngine, texts: payload, source: from, target: to, config });
    const fresh = [];
    translated.forEach((value, index) => {
      const text = guard ? guard.restore(value) : value;
      results[pending[index].index] = text;
      if (text) fresh.push([pending[index].key, text]);
    });
    writeCache(fresh);
  }

  return results;
}

async function handleTest({ engine }) {
  const settings = await loadSettings();
  const useEngine = engine || settings.engine;
  const config = { ...(settings.engines[useEngine] || {}) };
  if (AI_ENGINES.includes(useEngine)) {
    config.prompt = settings.ai.prompt || '';
    config.glossary = settings.ai.glossary || '';
    config.temperature = settings.ai.temperature;
  }
  const [sample] = await translateTexts({
    engine: useEngine,
    texts: ['The quick brown fox jumps over the lazy dog.'],
    source: 'auto',
    target: settings.targetLanguage,
    config
  });
  return sample;
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const fail = error => respond({ error: error?.message || String(error) });

  if (message?.type === 'translate') {
    handleTranslate(message).then(texts => respond({ texts })).catch(fail);
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
  if (message?.type === 'open-options') {
    chrome.runtime.openOptionsPage();
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
