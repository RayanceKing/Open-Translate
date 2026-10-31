import { loadSettings } from './lib/store.js';
import { translateTexts } from './lib/engines.js';
import { maskAll } from './lib/privacy.js';
import { AI_ENGINES } from './lib/defaults.js';
import { cacheKey, readCache, writeCache, clearCache, cacheStats } from './lib/cache.js';
import { resolveGlossary, glossarySalt, protectGlossary } from './lib/glossary.js';

/** Anything that changes the meaning of a translation without changing the text. */
function promptSalt(settings, engine) {
  if (!AI_ENGINES.includes(engine)) return '';
  return `${settings.ai.prompt || ''}\u0000${settings.ai.temperature}`;
}

async function handleTranslate({ texts = [], engine, source, target }, snapshot, skipCache = false) {
  const settings = snapshot || await loadSettings();
  const useEngine = engine || settings.engine;
  const to = target || settings.targetLanguage;
  const from = source || settings.sourceLanguage || 'auto';
  const config = { ...(settings.engines[useEngine] || {}) };
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
    const guard = settings.privacy.maskSensitive ? maskAll(pending.map(item => item.text)) : null;
    const masked = guard ? guard.safe : pending.map(item => item.text);
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
      const text = guard ? guard.restore(value) : value;
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
