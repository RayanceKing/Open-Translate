// ==UserScript==
// @name         Open Translate · Bilingual Web Reader
// @namespace    https://github.com/open-translate
// @version      0.3.0
// @description  In-place bilingual translation with switchable engines, AI providers and style presets. Option+T to toggle.
// @author       Open Translate contributors
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      translate.googleapis.com
// @connect      api.mymemory.translated.net
// @connect      api-free.deepl.com
// @connect      api.deepl.com
// @connect      api.cognitive.microsofttranslator.com
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      generativelanguage.googleapis.com
// @connect      api.anthropic.com
// @connect      www.bing.com
// @connect      cn.bing.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const MARK = 'data-open-translate';
  const SKIP = 'script,style,noscript,textarea,input,select,option,button,code,pre,kbd,samp,svg,canvas,[contenteditable="true"],[data-open-translate]';
  const BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,td,th,dd,dt';
  const INNER_HOSTS = ['LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE'];
  // Prefetch band around the viewport: start translating a paragraph slightly
  // before it scrolls into view so it is usually ready by the time the reader
  // reaches it, without translating the whole document up front.
  const LAZY_ROOT_MARGIN = '400px 0px';
  const LAZY_MARGIN_PX = 400;
  const SITE_RULES = {
    'github.com': ['article.markdown-body', '.js-comment-body', '.markdown-body'],
    'reddit.com': ['[data-testid="post-content"]', '[id^="t3_"]', 'shreddit-post'],
    'news.ycombinator.com': ['.titleline', '.commtext'],
    'medium.com': ['article'],
    'substack.com': ['article', '.post-content']
  };

  const LANGUAGES = [
    ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English 英语'], ['ja', '日本語 日语'],
    ['ko', '한국어 韩语'], ['fr', 'Français 法语'], ['de', 'Deutsch 德语'], ['es', 'Español 西班牙语'],
    ['ru', 'Русский 俄语'], ['pt', 'Português 葡萄牙语'], ['it', 'Italiano 意大利语'], ['nl', 'Nederlands 荷兰语'],
    ['pl', 'Polski 波兰语'], ['tr', 'Türkçe 土耳其语'], ['ar', 'العربية 阿拉伯语'], ['hi', 'हिन्दी 印地语'],
    ['th', 'ไทย 泰语'], ['vi', 'Tiếng Việt 越南语'], ['id', 'Bahasa Indonesia 印尼语'], ['uk', 'Українська 乌克兰语']
  ];
  const LANG_LABEL = Object.fromEntries(LANGUAGES);

  const ENGINE_NAMES = {
    google: 'Google 翻译', mymemory: 'MyMemory', deepl: 'DeepL', microsoft: 'Microsoft 翻译',
    libre: 'LibreTranslate', openai: 'OpenAI', deepseek: 'DeepSeek', gemini: 'Google Gemini', claude: 'Claude'
  };

  const ENGINE_SHORT = {
    google: 'Google', mymemory: 'MyMemory', deepl: 'DeepL', microsoft: '微软',
    libre: 'Libre', openai: 'OpenAI', deepseek: 'DeepSeek', gemini: 'Gemini', claude: 'Claude'
  };

  const ENGINE_FIELDS = {
    google: [],
    mymemory: [],
    deepl: [
      { key: 'key', label: 'API Key', type: 'password', placeholder: 'xxxxxxxx:fx' },
      { key: 'pro', label: '使用 Pro 端点', type: 'switch' }
    ],
    microsoft: [
      { key: 'useKey', label: '使用 Azure 密钥', type: 'switch' },
      { key: 'key', label: '订阅密钥', type: 'password', dependsOn: 'useKey' },
      { key: 'region', label: '区域', type: 'text', placeholder: 'global', dependsOn: 'useKey' }
    ],
    libre: [
      { key: 'url', label: '实例地址', type: 'text', placeholder: 'https://libretranslate.example.com' },
      { key: 'key', label: 'API Key', type: 'password', placeholder: '可留空' }
    ],
    openai: [
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gpt-4o-mini' }
    ],
    deepseek: [
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://api.deepseek.com/v1' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'deepseek-chat' }
    ],
    gemini: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'AIza...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gemini-2.0-flash' }
    ],
    claude: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-ant-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'claude-3-5-haiku-latest' }
    ]
  };

  const AI_ENGINES = ['openai', 'deepseek', 'gemini', 'claude'];

  const DEFAULT_PROMPT = [
    'You are a professional translator. Translate the text into {{target}}.',
    'Rules:',
    '1. Output only the translation. No explanations, no notes, no surrounding quotes.',
    '2. Preserve the original paragraph breaks, markdown, links, numbers, code and proper nouns.',
    '3. Keep the tone natural and idiomatic for native readers.'
  ].join('\n');

  const PRESETS = [
    ['plain', '无样式'], ['underline', '虚线下划线'], ['divider', '左侧竖线'], ['card', '卡片'],
    ['quote', '引用块'], ['highlight', '高亮'], ['faded', '淡色'], ['blur', '模糊']
  ];

  const DEFAULTS = {
    engine: 'google',
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    displayMode: 'bilingual',
    autoTranslate: false,
    batchSize: 4,
    concurrency: 2,
    privacy: { maskSensitive: true },
    style: {
      preset: 'underline', fontSize: 100, lineHeight: 1.7, fontWeight: 400, opacity: 100,
      colorMode: 'inherit', color: '#3f3f46', accent: '#6d5dfc', background: '#6d5dfc',
      radius: 6, paddingX: 8, paddingY: 2, marginTop: 4, marginBottom: 12
    },
    ai: { prompt: DEFAULT_PROMPT, glossary: '', temperature: 0.2 },
    engines: {
      google: {}, mymemory: {},
      deepl: { key: '', pro: false },
      microsoft: { useKey: false, key: '', region: 'global' },
      libre: { url: '', key: '' },
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
      gemini: { apiKey: '', model: 'gemini-2.0-flash' },
      claude: { apiKey: '', model: 'claude-3-5-haiku-latest' }
    },
    siteRules: { blacklist: [], alwaysTranslate: [] },
    subtitles: { enabled: true, mode: 'bilingual', fontSize: 100, position: 10, background: true, shortcut: 'Alt+S' },
    ui: { showFloatingButton: true, dock: { side: 'right', top: 0.68 } }
  };

  let settings = null;
  let active = false;
  let observer = null;
  let intersectionObserver = null;
  let lastIoAt = 0;
  let inflight = 0;
  const pending = new Set();
  let flushScheduled = false;
  const queue = [];
  const originalHtml = new Map();
  let translating = new WeakSet();
  let bubble = null;

  // ---------------------------------------------------------------- settings

  const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

  function deepMerge(base, patch) {
    if (!isPlainObject(patch)) return base;
    for (const [key, value] of Object.entries(patch)) {
      if (isPlainObject(value) && isPlainObject(base[key])) deepMerge(base[key], value);
      else if (value !== undefined) base[key] = value;
    }
    return base;
  }

  function loadSettings() {
    let stored = null;
    try {
      stored = GM_getValue('settings', null);
    } catch {
      stored = null;
    }
    let saved = null;
    try {
      saved = typeof stored === 'string' ? JSON.parse(stored) : stored;
    } catch {
      saved = null;
    }
    const next = structuredClone(DEFAULTS);
    if (saved) deepMerge(next, saved);
    // Before 0.2.0 Microsoft only had a keyed Azure channel, so a stored key
    // with no `useKey` flag means the user was on Azure — keep them there.
    const legacy = saved && saved.engines && saved.engines.microsoft;
    if (legacy && legacy.useKey === undefined && String(legacy.key || '').trim()) {
      next.engines.microsoft.useKey = true;
    }
    return next;
  }

  function persist() {
    try {
      GM_setValue('settings', settings);
    } catch {
      /* private mode */
    }
  }

  // Initialised after the merge helpers above so a stored config cannot hit a
  // temporal-dead-zone error while the script is still evaluating.
  settings = loadSettings();

  const getPath = (object, path) => path.split('.').reduce((value, key) => (value == null ? value : value[key]), object);

  function setPath(object, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((node, key) => (node[key] ??= {}), object);
    target[last] = value;
  }

  // ---------------------------------------------------------------- utilities

  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const host = location.hostname.replace(/^www\./, '');

  const matchesSite = pattern => {
    const target = String(pattern).replace(/^\*\.?/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return Boolean(target) && (host === target || host.endsWith(`.${target}`));
  };

  function hexToRgba(hex, alpha) {
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
    if (!match) return `rgba(109, 93, 252, ${alpha})`;
    const [r, g, b] = match.slice(1).map(part => parseInt(part, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // YouTube (and a handful of other sites) send `require-trusted-types-for
  // 'script'`, which makes any `element.innerHTML = "<markup>"` throw a
  // TypeError. Route every markup write through our own Trusted Types policy
  // so the UI still builds there. Empty strings stay exempt, so clearing an
  // element does not need this wrapper.
  const trustedPolicy = (() => {
    try {
      return window.trustedTypes?.createPolicy?.('open-translate', { createHTML: markup => markup }) || null;
    } catch {
      return null; // the page may already own a policy with that name
    }
  })();

  const trustedHtml = markup => (trustedPolicy ? trustedPolicy.createHTML(markup) : markup);

  // Values interpolated into that markup come from user settings, so they must
  // not be able to inject tags — the policy above intentionally does not filter.
  const escapeHtml = value =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  function maskAll(texts) {
    const values = [];
    const put = value => `__OT_PRIVATE_${values.push(value) - 1}__`;
    const patterns = [
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      /\b(?:\+?\d[\s-]?){8,16}\b/g,
      /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g
    ];
    const safe = texts.map(text => patterns.reduce((out, pattern) => out.replace(pattern, put), String(text)));
    return {
      safe,
      restore: output => String(output).replace(/__\s*OT_PRIVATE\s*_(\d+)\s*__/gi, (whole, index) => values[Number(index)] ?? whole)
    };
  }

  // ---------------------------------------------------------------- transport

  function http({ url, method = 'GET', headers = {}, data = null, timeout = 25000 }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        timeout,
        onload: response => {
          let parsed = response.responseText;
          try {
            parsed = response.responseText ? JSON.parse(response.responseText) : null;
          } catch {
            /* keep text */
          }
          if (response.status < 200 || response.status >= 300) {
            const detail = parsed?.error?.message || parsed?.message || String(response.responseText || '').slice(0, 120);
            reject(new Error(`服务返回错误（HTTP ${response.status}）${detail ? '：' + detail : ''}`));
            return;
          }
          resolve(parsed);
        },
        onerror: () => reject(new Error('无法连接翻译服务')),
        ontimeout: () => reject(new Error('翻译请求超时'))
      });
    });
  }

  // ---------------------------------------------------------------- engines

  const trimSlash = value => String(value || '').replace(/\/+$/, '');

  function buildPrompt(texts, target) {
    const template = String(settings.ai.prompt || '').trim() || DEFAULT_PROMPT;
    const head = template.replaceAll('{{target}}', LANG_LABEL[target] || target).replaceAll('{{source}}', 'the original language');
    const parts = [head];
    if (settings.ai.glossary.trim()) parts.push(`Glossary — always use these translations verbatim:\n${settings.ai.glossary.trim()}`);
    if (texts.length === 1) parts.push(`Text:\n<<<\n${texts[0]}\n>>>`);
    else parts.push(`Translate each of the ${texts.length} numbered segments, keeping the leading number:\n` + texts.map((text, index) => `${index + 1}. ${text}`).join('\n'));
    return parts.join('\n\n');
  }

  function parseNumbered(raw, count) {
    const map = new Map();
    let current = null;
    for (const line of String(raw).split('\n')) {
      const match = /^\s*(\d+)\s*[.、)．:：]\s*(.*)$/.exec(line);
      const index = match ? Number(match[1]) : NaN;
      if (match && index >= 1 && index <= count) {
        current = index;
        map.set(index, match[2]);
      } else if (current !== null && line.trim()) {
        map.set(current, `${map.get(current) || ''}\n${line.trim()}`);
      }
    }
    if (map.size !== count) return null;
    return Array.from({ length: count }, (_, index) => (map.get(index + 1) || '').trim());
  }

  const unwrap = raw => String(raw).replace(/^\s*<<<\s*/, '').replace(/\s*>>>\s*$/, '').replace(/^["'“”]([\s\S]*)["'“”]$/, '$1').trim();

  async function runAi(ask, texts, target) {
    if (texts.length === 1) return [unwrap(await ask(buildPrompt(texts, target)))];
    const parsed = parseNumbered(await ask(buildPrompt(texts, target)), texts.length);
    if (parsed) return parsed;
    const output = [];
    for (const text of texts) output.push(unwrap(await ask(buildPrompt([text], target))));
    return output;
  }

  // Microsoft: free channel (same public endpoint the Bing translator page uses)
  // by default, official Azure API when a subscription key is configured.
  let bingCredsCache = null;

  function httpText(url, headers = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers,
        timeout: 20000,
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`微软免费通道不可用（HTTP ${response.status}）`));
          } else {
            resolve({ text: response.responseText, url: response.finalUrl || url });
          }
        },
        onerror: () => reject(new Error('无法连接微软翻译')),
        ontimeout: () => reject(new Error('微软免费通道请求超时'))
      });
    });
  }

  async function bingCredentials(force = false) {
    if (!force && bingCredsCache && Date.now() - bingCredsCache.at < 8 * 60 * 1000) return bingCredsCache;
    const page = await httpText('https://www.bing.com/translator', { Accept: 'text/html' });
    const ig = /IG:"([0-9A-Fa-f]+)"/.exec(page.text);
    const iid = /data-iid="([^"]+)"/.exec(page.text);
    const abuse = /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)/.exec(page.text);
    if (!ig || !abuse) throw new Error('微软免费通道返回了无法识别的页面，可在引擎设置里改用 Azure 密钥');
    bingCredsCache = {
      host: new URL(page.url).origin,
      ig: ig[1],
      iid: iid?.[1] || 'translator.5023',
      key: abuse[1],
      token: abuse[2],
      at: Date.now()
    };
    return bingCredsCache;
  }

  async function bingTranslateOne(text, to, credentials) {
    const body = new URLSearchParams({
      fromLang: 'auto-detect',
      to,
      text: text.slice(0, 4000),
      token: credentials.token,
      key: credentials.key
    }).toString();
    try {
      const data = await http({
        url: `${credentials.host}/ttranslatev3?isVertical=1&IG=${credentials.ig}&IID=${credentials.iid}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: body
      });
      const result = data?.[0]?.translations?.[0]?.text;
      if (!result) throw new Error('微软免费通道没有返回译文');
      return result;
    } catch (error) {
      if (/HTTP 40[13]/.test(error.message)) {
        const expired = new Error('微软免费通道凭证已过期');
        expired.retryable = true;
        throw expired;
      }
      throw error;
    }
  }

  async function microsoftFree(texts, target) {
    const to = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' }[target] || target;
    const run = async credentials => {
      const output = [];
      for (const text of texts) output.push(await bingTranslateOne(text, to, credentials));
      return output;
    };
    try {
      return await run(await bingCredentials());
    } catch (error) {
      if (!error.retryable) throw error;
      bingCredsCache = null;
      return run(await bingCredentials(true));
    }
  }

  async function translateBatch(texts, target) {
    const engine = settings.engine;
    const cfg = settings.engines[engine] || {};

    if (engine === 'google') {
      const output = [];
      for (const text of texts) {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
        const data = await http({ url });
        output.push((data?.[0] || []).map(segment => segment?.[0] || '').join(''));
      }
      return output;
    }

    if (engine === 'mymemory') {
      const output = [];
      for (const text of texts) {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=auto%7C${encodeURIComponent(target)}`;
        const data = await http({ url });
        if (data?.responseStatus !== 200) throw new Error(data?.responseDetails || 'MyMemory 服务不可用');
        output.push(data.responseData.translatedText);
        await sleep(120);
      }
      return output;
    }

    if (engine === 'deepl') {
      if (!cfg.key) throw new Error('尚未填写 DeepL API Key');
      const base = cfg.pro ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
      const map = { 'zh-CN': 'ZH', 'zh-TW': 'ZH-HANT', en: 'EN-US', pt: 'PT-PT' };
      const data = await http({
        url: `${base}/v2/translate`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${cfg.key}` },
        data: JSON.stringify({ text: texts, target_lang: map[target] || String(target).toUpperCase() })
      });
      return (data?.translations || []).map(item => item.text);
    }

    if (engine === 'microsoft') {
      if (!cfg.useKey) return microsoftFree(texts, target);
      if (!cfg.key) throw new Error('尚未填写 Azure 订阅密钥，或关闭「使用 Azure 密钥」改用免费通道');
      const msTarget = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' }[target] || target;
      const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': cfg.key };
      if (cfg.region && cfg.region !== 'global') headers['Ocp-Apim-Subscription-Region'] = cfg.region;
      const data = await http({
        url: `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(msTarget)}`,
        method: 'POST',
        headers,
        data: JSON.stringify(texts.map(text => ({ Text: text })))
      });
      return (data || []).map(item => item?.translations?.[0]?.text || '');
    }

    if (engine === 'libre') {
      if (!cfg.url) throw new Error('尚未填写 LibreTranslate 实例地址');
      const body = { q: texts, source: 'auto', target: String(target).split('-')[0], format: 'text' };
      if (cfg.key) body.api_key = cfg.key;
      const data = await http({
        url: `${trimSlash(cfg.url)}/translate`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body)
      });
      const result = data?.translatedText;
      return Array.isArray(result) ? result : [String(result || '')];
    }

    if (engine === 'openai' || engine === 'deepseek') {
      if (!cfg.apiKey) throw new Error('尚未填写 API Key');
      const base = trimSlash(cfg.baseUrl) || 'https://api.openai.com/v1';
      return runAi(async prompt => {
        const data = await http({
          url: `${base}/chat/completions`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          data: JSON.stringify({
            model: cfg.model || 'gpt-4o-mini',
            temperature: Number(settings.ai.temperature ?? 0.2),
            messages: [
              { role: 'system', content: 'You are a precise translator. You output only the translation.' },
              { role: 'user', content: prompt }
            ]
          })
        });
        const content = data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('模型没有返回译文');
        return content;
      }, texts, target);
    }

    if (engine === 'gemini') {
      if (!cfg.apiKey) throw new Error('尚未填写 Gemini API Key');
      const model = cfg.model || 'gemini-2.0-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
      return runAi(async prompt => {
        const data = await http({
          url,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({
            systemInstruction: { parts: [{ text: 'You are a precise translator. You output only the translation.' }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: Number(settings.ai.temperature ?? 0.2) }
          })
        });
        const parts = data?.candidates?.[0]?.content?.parts;
        const content = Array.isArray(parts) ? parts.map(part => part.text || '').join('') : '';
        if (!content) throw new Error('模型没有返回译文');
        return content;
      }, texts, target);
    }

    if (engine === 'claude') {
      if (!cfg.apiKey) throw new Error('尚未填写 Anthropic API Key');
      return runAi(async prompt => {
        const data = await http({
          url: 'https://api.anthropic.com/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          data: JSON.stringify({
            model: cfg.model || 'claude-3-5-haiku-latest',
            max_tokens: 4096,
            temperature: Number(settings.ai.temperature ?? 0.2),
            system: 'You are a precise translator. You output only the translation.',
            messages: [{ role: 'user', content: prompt }]
          })
        });
        const content = Array.isArray(data?.content) ? data.content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
        if (!content) throw new Error('模型没有返回译文');
        return content;
      }, texts, target);
    }

    throw new Error(`未知的翻译引擎：${engine}`);
  }

  // ---------------------------------------------------------------- cache
  // Session-scoped: sessionStorage survives a reload in the same tab but is
  // dropped when the tab closes, which matches "temporary". Only fingerprints
  // and translations are stored — never the source text itself.

  const CACHE_STORE = 'ot-cache';
  const CACHE_TTL = 12 * 60 * 60 * 1000;
  const CACHE_LIMIT = 2000;
  let cacheMap = null;

  function cacheEntries() {
    if (cacheMap) return cacheMap;
    try {
      cacheMap = JSON.parse(sessionStorage.getItem(CACHE_STORE) || '{}') || {};
    } catch {
      cacheMap = {};
    }
    return cacheMap;
  }

  function cacheFlush() {
    try {
      sessionStorage.setItem(CACHE_STORE, JSON.stringify(cacheEntries()));
    } catch {
      // Quota exceeded — drop the oldest half and try once more.
      const keys = Object.keys(cacheEntries());
      keys.slice(0, Math.ceil(keys.length / 2)).forEach(key => delete cacheEntries()[key]);
      try {
        sessionStorage.setItem(CACHE_STORE, JSON.stringify(cacheEntries()));
      } catch {
        /* stay memory-only for this page */
      }
    }
  }

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

  function cacheKeyFor(text) {
    const salt = AI_ENGINES.includes(settings.engine)
      ? `${settings.ai.prompt}\u0000${settings.ai.glossary}\u0000${settings.ai.temperature}`
      : '';
    return [settings.engine, settings.targetLanguage, salt ? fingerprint(salt) : '0', fingerprint(String(text))].join('|');
  }

  function cacheCount() {
    const now = Date.now();
    return Object.values(cacheEntries()).filter(entry => entry && typeof entry.v === 'string' && now - entry.t < CACHE_TTL).length;
  }

  function clearTranslationCache() {
    cacheMap = {};
    try {
      sessionStorage.removeItem(CACHE_STORE);
    } catch {
      /* ignore */
    }
  }

  async function requestTranslation(texts) {
    const entries = cacheEntries();
    const now = Date.now();
    const keys = texts.map(cacheKeyFor);
    const results = new Array(texts.length);
    const pending = [];

    texts.forEach((text, index) => {
      const entry = entries[keys[index]];
      if (entry && typeof entry.v === 'string' && now - entry.t < CACHE_TTL) results[index] = entry.v;
      else pending.push({ text, index, key: keys[index] });
    });

    if (pending.length) {
      const guard = settings.privacy.maskSensitive ? maskAll(pending.map(item => item.text)) : null;
      const payload = guard ? guard.safe : pending.map(item => item.text);
      const output = await translateBatch(payload, settings.targetLanguage);
      output.forEach((value, index) => {
        const text = guard ? guard.restore(value) : value;
        results[pending[index].index] = text;
        if (text) entries[pending[index].key] = { v: text, t: now };
      });
      const stored = Object.keys(entries);
      if (stored.length > CACHE_LIMIT) stored.slice(0, stored.length - CACHE_LIMIT).forEach(key => delete entries[key]);
      cacheFlush();
    }

    return results;
  }

  // ---------------------------------------------------------------- subtitles
  // Mirrors the extension module: textTracks / fetched VTT / YouTube json3 all
  // normalise into the same cue list, rendered by our own overlay.

  const SUB_ATTR = 'data-ot-sub';
  const SUB_PREFETCH = 12;
  const SUB_CSS = `
    .ot-sub { position: fixed; left: 0; bottom: 0; z-index: 2147483000; display: flex; flex-direction: column;
      align-items: center; gap: 2px; padding: 0 5%; pointer-events: none; opacity: 0;
      transition: opacity .14s ease; font-size: 22px; line-height: 1.35; text-align: center;
      text-shadow: 0 1px 3px rgba(0,0,0,.85); box-sizing: border-box; }
    .ot-sub.is-visible { opacity: 1; }
    .ot-sub.is-offscreen { opacity: 0 !important; }
    .ot-sub-src, .ot-sub-dst { max-width: 100%; padding: 2px 10px; border-radius: 6px; color: #fff;
      white-space: pre-wrap; overflow-wrap: anywhere; }
    .ot-sub-src { font-size: .78em; opacity: .82; }
    .ot-sub-src:empty, .ot-sub-dst:empty { display: none; }
    .ot-sub.ot-sub-solid .ot-sub-src, .ot-sub.ot-sub-solid .ot-sub-dst { background: rgba(0,0,0,.62); }
    .ot-sub.ot-sub-dst-only .ot-sub-src { display: none; }
    html.ot-sub-on:not(.ot-sub-ythook) .ytp-caption-window-container, html.ot-sub-on:not(.ot-sub-ythook) .ytp-caption-window-container * { display: none !important; }
    .ot-yt-sub { position: fixed; z-index: 2147483000; padding: 2px 10px; border-radius: 6px; color: #fff; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,.85); background: rgba(0,0,0,.55); pointer-events: none; opacity: 0; transition: opacity .14s ease; box-sizing: border-box; max-width: 92vw; white-space: pre-wrap; overflow-wrap: anywhere; }
    .ot-yt-sub.is-visible { opacity: 1; }
  `;

  const SUB = {
    on: false, userOff: false, video: null, layer: null, cues: [], index: -1,
    raf: 0, watchdog: 0, lastTick: 0, loading: false, pending: new Set(), handlers: null,
    cueHandler: null, mode: null, styled: false, errorAt: 0
  };

  const subHost = location.hostname.replace(/^www\./, '');
  const isYouTube = () => /(^|\.)youtube\.com$/.test(subHost) || /(^|\.)youtube-nocookie\.com$/.test(subHost);

  function injectSubStyle() {
    if (SUB.styled) return;
    SUB.styled = true;
    const style = document.createElement('style');
    style.id = 'ot-sub-style';
    style.textContent = SUB_CSS;
    (document.head || document.documentElement).append(style);
  }

  // Pick the video the user is actually watching. A page can hold several
  // <video> elements (previews, mini players, ad slots, a paused poster), and
  // binding to one that is not playing freezes `currentTime` -- the overlay then
  // shows whatever line was current when we attached and never advances. So we
  // prefer an element that is actively playing; visible area only breaks ties.
  function findMainVideo() {
    const candidates = [...document.querySelectorAll('video')].filter(node => {
      if (!node.currentSrc && !node.src) return false;
      const rect = node.getBoundingClientRect();
      return rect.width >= 160 && rect.height >= 90;
    });
    if (!candidates.length) return null;
    const playing = candidates.filter(node => !node.paused && !node.ended && node.readyState >= 2);
    const pool = playing.length ? playing : candidates;
    return pool.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
  }

  function subTimestamp(value) {
    const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(String(value).trim());
    if (!match) return null;
    const [, hours, minutes, seconds, fraction] = match;
    return Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction.padEnd(3, '0')) / 1000;
  }

  function parseVtt(text) {
    const cues = [];
    const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n').filter(line => line.trim());
      if (!lines.length) continue;
      if (/^WEBVTT/.test(lines[0]) || /^NOTE\b/.test(lines[0])) continue;
      const timeIndex = lines.findIndex(line => line.includes('-->'));
      if (timeIndex < 0) continue;
      const [rawStart, rawEnd] = lines[timeIndex].split('-->');
      const start = subTimestamp(rawStart);
      const end = subTimestamp(String(rawEnd || '').trim().split(/\s+/)[0]);
      if (start == null || end == null) continue;
      const body = lines.slice(timeIndex + 1).join(' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const value = clean(body);
      if (value) cues.push({ start, end: Math.max(end, start + 0.4), text: value, translation: null });
    }
    return cues;
  }

  function parseJson3(data) {
    const events = Array.isArray(data?.events) ? data.events : [];
    const cues = [];
    for (const event of events) {
      if (!Array.isArray(event?.segs)) continue;
      const value = clean(event.segs.map(segment => segment?.utf8 || '').join(''));
      if (!value) continue;
      const start = (Number(event.tStartMs) || 0) / 1000;
      const duration = (Number(event.dDurationMs) || 0) / 1000;
      cues.push({ start, end: Math.max(start + duration, start + 0.4), text: value, translation: null });
    }
    return cues;
  }

  function cuesFromTextTracks(video) {
    const tracks = [...(video.textTracks || [])];
    const track =
      tracks.find(item => item.kind === 'subtitles') ||
      tracks.find(item => item.kind === 'captions') ||
      tracks[0];
    if (!track) return [];
    if (track.mode === 'disabled') track.mode = 'hidden';
    const list = track.cues;
    if (!list || !list.length) return [];
    return [...list]
      .map(cue => ({
        start: cue.startTime,
        end: Math.max(cue.endTime, cue.startTime + 0.4),
        text: clean(cue.text || ''),
        translation: null
      }))
      .filter(cue => cue.text);
  }

  async function cuesFromVttElement(video) {
    const element = video.querySelector('track[src]');
    if (!element) return [];
    try {
      const text = await http({ url: element.src, timeout: 15000 });
      return typeof text === 'string' ? parseVtt(text) : [];
    } catch {
      return [];
    }
  }

  function youtubeCaptionTracks() {
    let response = null;
    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') response = player.getPlayerResponse();
    } catch {
      /* player not ready */
    }
    if (!response) response = window.ytInitialPlayerResponse;
    const list = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(list) ? list : [];
  }

  function pickCaptionTrack(tracks) {
    const wanted = settings.sourceLanguage;
    const score = track => {
      let value = 0;
      if (track.kind !== 'asr') value += 4;
      if (wanted !== 'auto' && track.languageCode === wanted) value += 8;
      if (wanted === 'auto' && track.languageCode === 'en') value += 1;
      return value;
    };
    return [...tracks].sort((a, b) => score(b) - score(a))[0] || null;
  }

  async function cuesFromYouTube() {
    const track = pickCaptionTrack(youtubeCaptionTracks());
    if (!track?.baseUrl) return [];
    const url = `${track.baseUrl}${track.baseUrl.includes('?') ? '&' : '?'}fmt=json3`;
    const data = await http({ url, timeout: 15000 });
    return typeof data === 'object' ? parseJson3(data) : [];
  }

  async function loadCues(video) {
    const native = cuesFromTextTracks(video);
    if (native.length) return native;
    const fromVtt = await cuesFromVttElement(video);
    if (fromVtt.length) return fromVtt;
    if (isYouTube()) return cuesFromYouTube();
    return [];
  }

  // ------------------------------------------------- YouTube native captions
  //
  // Immersive-translate style: instead of polling video.currentTime and binary
  // searching our own cue list, we let YouTube paint the original line and we
  // watch its caption window. Whenever YouTube renders a new line we grab the
  // text, translate it, and paint the translation just above YouTube's own
  // caption. The original stays native; we only add the translation. If we
  // cannot turn captions on (no track, internal API gone), callers fall back to
  // the injected-track path below.

  const YT_CAPTION_CONTAINER = '.ytp-caption-window-container';
  const YT_CAPTION_SEGMENT = '.ytp-caption-segment';
  const ytTransCache = new Map();

  function enableYouTubeCaptions() {
    const player = document.getElementById('movie_player');
    if (!player || typeof player.setOption !== 'function') return false;
    const track = pickCaptionTrack(youtubeCaptionTracks());
    if (!track) return false;
    const shapes = [
      () => player.setOption('captions', 'track', { languageCode: track.languageCode, kind: track.kind || 'asr', name: track.name }),
      () => player.setOption('captions', 'track', track.languageCode),
      () => player.setOption('captions', 'track', { languageCode: track.languageCode })
    ];
    for (const shape of shapes) {
      try { shape(); return true; } catch { /* try next shape */ }
    }
    return false;
  }

  function ytCaptionContainer() {
    return document.querySelector(YT_CAPTION_CONTAINER);
  }

  function ytCurrentText() {
    const container = ytCaptionContainer();
    if (!container) return '';
    const segments = container.querySelectorAll(YT_CAPTION_SEGMENT);
    if (!segments.length) return '';
    return [...segments].map(node => node.textContent).join(' ').replace(/\s+/g, ' ').trim();
  }

  function ensureYtLayer() {
    let layer = document.querySelector('.ot-yt-sub');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.className = 'ot-yt-sub';
    layer.setAttribute(SUB_ATTR, '');
    (document.getElementById('movie_player') || document.body).append(layer);
    return layer;
  }

  function positionYtLayer(layer) {
    const container = ytCaptionContainer();
    if (!container || !layer) return;
    const ref = container.querySelector('.ytp-caption-window-rollup, .caption-window') || container;
    const rect = ref.getBoundingClientRect();
    layer.style.fontSize = `${clampValue(rect.height * 0.085, 14, 40)}px`;
    layer.style.left = `${rect.left}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.top = `${Math.max(4, rect.top - 2)}px`;
    layer.style.transform = 'translateY(-100%)';
  }

  async function ytRenderText(text) {
    const layer = ensureYtLayer();
    if (!text) { layer.classList.remove('is-visible'); layer.textContent = ''; return; }
    let translation = ytTransCache.get(text);
    if (translation === undefined) {
      try {
        translation = (await requestTranslation([text]))[0] || '';
      } catch {
        translation = '';
      }
      ytTransCache.set(text, translation);
    }
    layer.textContent = translation;
    layer.classList.toggle('is-visible', Boolean(translation));
    positionYtLayer(layer);
  }

  let ytObserver = null;
  let ytLastText = '';

  function startYouTubeHook() {
    if (!enableYouTubeCaptions()) return false;
    const container = ytCaptionContainer();
    if (!container) return false;
    ytLastText = '';
    let scheduled = false;
    const tick = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(async () => {
        scheduled = false;
        const text = ytCurrentText();
        if (text === ytLastText) return;
        ytLastText = text;
        await ytRenderText(text);
      }, 0);
    };
    ytObserver = new MutationObserver(tick);
    ytObserver.observe(container, { childList: true, subtree: true, characterData: true });
    tick();
    return true;
  }

  function stopYouTubeHook() {
    if (ytObserver) { ytObserver.disconnect(); ytObserver = null; }
    document.querySelector('.ot-yt-sub')?.remove();
    ytLastText = '';
  }

  // --------------------------------------------------- injected-track driver
  //
  // Fallback for non-YouTube pages and for YouTube when native captions cannot
  // be turned on. We feed the cue list into a hidden <track> on the playing
  // video and let the browser drive cue switching through the `cuechange`
  // event. No currentTime polling, no binary search, no watchdog -- the media
  // pipeline is the single source of truth for "what line is on now".

  function cuesToVtt(cues) {
    const stamp = seconds => {
      const ms = Math.floor((seconds % 1) * 1000);
      const total = Math.floor(seconds);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    };
    const blocks = ['WEBVTT', ''];
    for (const cue of cues) {
      blocks.push(`${stamp(cue.start)} --> ${stamp(cue.end)}`);
      blocks.push(cue.text);
      blocks.push('');
    }
    return blocks.join('\n');
  }

  async function injectHiddenTrack(video, cues) {
    const vtt = cuesToVtt(cues);
    const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    let element = video.querySelector('track[data-ot]');
    if (!element) {
      element = document.createElement('track');
      element.setAttribute('data-ot', '');
      element.kind = 'subtitles';
      element.srclang = (settings.sourceLanguage || 'en').split('-')[0];
      video.appendChild(element);
    }
    element.src = url;
    element.mode = 'hidden';
    const textTrack = await new Promise(resolve => {
      const settle = () => {
        element.removeEventListener('load', settle);
        element.removeEventListener('error', settle);
        resolve(element.track || null);
      };
      element.addEventListener('load', settle);
      element.addEventListener('error', settle);
      if (element.track && element.track.cues) settle();
      setTimeout(() => resolve(element.track || null), 2500);
    });
    SUB.cueHandler = { track: textTrack, url, onCue: null };
    return textTrack;
  }

  async function startCueDriver(video, cues) {
    cues.sort((a, b) => a.start - b.start);
    SUB.cues = cues;
    SUB.index = -1;
    SUB.video = video;
    const track = await injectHiddenTrack(video, cues);
    if (!track) return false;
    const onCue = () => {
      const active = track.activeCues;
      if (!active || !active.length) {
        SUB.index = -1;
        renderCue(-1);
        positionSubLayer();
        return;
      }
      let index = -1;
      for (const cue of active) {
        const hit = SUB.cues.findIndex(c => Math.abs(c.start - cue.startTime) < 0.05);
        if (hit >= 0) { index = hit; break; }
      }
      if (index < 0) return;
      SUB.index = index;
      renderCue(index);
      positionSubLayer();
    };
    track.addEventListener('cuechange', onCue);
    track.mode = 'hidden';
    SUB.cueHandler.onCue = onCue;
    onCue();
    return true;
  }

  function ensureLayer() {
    if (SUB.layer?.isConnected) return SUB.layer;
    injectSubStyle();
    const layer = document.createElement('div');
    layer.className = 'ot-sub';
    layer.setAttribute(SUB_ATTR, '');
    layer.innerHTML = trustedHtml('<div class="ot-sub-src"></div><div class="ot-sub-dst"></div>');
    document.body.append(layer);
    SUB.layer = layer;
    return layer;
  }

  function applySubtitleStyle() {
    const layer = SUB.layer;
    if (!layer) return;
    layer.classList.toggle('ot-sub-solid', Boolean(settings.subtitles.background));
    layer.classList.toggle('ot-sub-dst-only', settings.subtitles.mode === 'translation');
  }

  function positionSubLayer() {
    const { layer, video } = SUB;
    if (!layer || !video) return;
    const rect = video.getBoundingClientRect();
    const offscreen = rect.bottom < 40 || rect.top > window.innerHeight - 40 || rect.width < 120;
    layer.classList.toggle('is-offscreen', offscreen);
    if (offscreen) return;
    const gap = (rect.height * settings.subtitles.position) / 100;
    layer.style.fontSize = `${clampValue(rect.height * 0.042, 14, 44) * (settings.subtitles.fontSize / 100)}px`;
    layer.style.left = `${rect.left}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.bottom = `${Math.max(0, window.innerHeight - rect.bottom) + gap}px`;
  }

  function findCueIndex(cues, time) {
    let low = 0;
    let high = cues.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start <= time) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found < 0) return -1;
    for (let index = found; index >= Math.max(0, found - 2); index -= 1) {
      if (cues[index].start <= time && time < cues[index].end) return index;
    }
    return -1;
  }

  function renderCue(index) {
    const layer = SUB.layer;
    if (!layer) return;
    const source = layer.querySelector('.ot-sub-src');
    const target = layer.querySelector('.ot-sub-dst');
    if (index < 0) {
      source.textContent = '';
      target.textContent = '';
      layer.classList.remove('is-visible');
      return;
    }
    const cue = SUB.cues[index];
    source.textContent = cue.text;
    target.textContent = cue.translation || '';
    layer.classList.add('is-visible');
    ensureSubTranslated(index);
  }

  function updateCue(force = false) {
    if (!SUB.video || !SUB.cues.length) return;
    const index = findCueIndex(SUB.cues, SUB.video.currentTime);
    if (!force && index === SUB.index) return;
    SUB.index = index;
    try {
      renderCue(index);
    } catch {
      /* one malformed cue must not stall the rest of the track */
    }
  }

  // Cue switching and layout are isolated from each other on purpose: a throw in
  // either one used to take the other down with it.
  function syncSubOnce() {
    SUB.lastTick = Date.now();
    const video = ensureSubVideo();
    if (!video) return;
    try { updateCue(); } catch { /* keep the driver alive */ }
    try { positionSubLayer(); } catch { /* keep the driver alive */ }
  }

  function stopSubTick() {
    if (SUB.raf) cancelAnimationFrame(SUB.raf);
    SUB.raf = 0;
    if (SUB.watchdog) clearInterval(SUB.watchdog);
    SUB.watchdog = 0;
  }

  // Three drivers, because each one can stall on its own:
  //   rAF          smooth while the tab is visible and the page is idle
  //   timeupdate   still fires when rAF is paused (background tab, busy page)
  //   watchdog     catches rAF silently stopping while the tab looks visible,
  //                which is exactly the "only the first cue ever shows" report
  function startSubTick() {
    stopSubTick();
    const step = () => {
      SUB.raf = requestAnimationFrame(step);
      syncSubOnce();
    };
    SUB.raf = requestAnimationFrame(step);
    SUB.watchdog = setInterval(() => {
      if (Date.now() - SUB.lastTick < 150) return; // rAF is healthy
      syncSubOnce();
    }, 250);
  }

  async function ensureSubTranslated(index) {
    const cues = SUB.cues;
    if (!cues.length) return;
    const from = Math.max(0, index - 2);
    const to = Math.min(cues.length - 1, index + SUB_PREFETCH);
    const missing = [];
    for (let cursor = from; cursor <= to; cursor += 1) {
      if (cues[cursor].translation === null && !SUB.pending.has(cursor)) missing.push(cursor);
    }
    if (!missing.length) return;
    missing.forEach(cursor => SUB.pending.add(cursor));
    const texts = missing.map(cursor => cues[cursor].text);
    try {
      const results = await requestTranslation(texts);
      results.forEach((value, position) => {
        const target = missing[position];
        if (cues[target]) cues[target].translation = value || '';
      });
      if (missing.includes(SUB.index)) {
        const line = SUB.layer?.querySelector('.ot-sub-dst');
        if (line) line.textContent = cues[SUB.index]?.translation || '';
      }
    } catch (error) {
      // A failed batch must not tear down the overlay: the original line is
      // still readable and the next window shift retries. After a second
      // failure the cue is marked as "translated to nothing" so we stop
      // hammering the engine on every frame.
      missing.forEach(cursor => {
        const cue = cues[cursor];
        if (!cue) return;
        cue.attempts = (cue.attempts || 0) + 1;
        if (cue.attempts >= 2) cue.translation = '';
      });
      if (Date.now() - SUB.errorAt > 10000) {
        SUB.errorAt = Date.now();
        toast(`字幕翻译失败：${error.message}`);
      }
    } finally {
      missing.forEach(cursor => SUB.pending.delete(cursor));
    }
  }

  // YouTube rebuilds its player on navigation, so the element we bound to can be
  // detached while the page keeps playing. Re-bind instead of reading a frozen
  // currentTime forever.
  function ensureSubVideo() {
    const current = SUB.video;
    // Healthy: still attached and actually playing. Nothing to do.
    if (current?.isConnected && !current.paused && !current.ended) return current;
    // The bound element stopped playing (paused, ended, or YouTube rebuilt the
    // player). Look for a better one instead of reading a frozen currentTime.
    const next = findMainVideo();
    if (!next) return current && current.isConnected ? current : null;
    if (next === current) return current;
    unbindSubVideo();
    SUB.video = next;
    SUB.index = -1;
    bindSubVideo(next);
    return next;
  }

  function bindSubVideo(video) {
    if (SUB.handlers?.video === video) return;
    unbindSubVideo();
    const onPlay = () => startSubTick();
    const onPause = () => {
      stopSubTick();
      updateCue();
      positionSubLayer();
    };
    const onSeek = () => {
      updateCue(true);
      positionSubLayer();
    };
    video.addEventListener('play', onPlay);
    video.addEventListener('playing', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeek);
    video.addEventListener('emptied', onSeek);
    // `timeupdate` fires ~4x/s even when rAF is paused, so the cue still
    // advances in a background tab or on a page that starves animation frames.
    video.addEventListener('timeupdate', syncSubOnce);
    video.addEventListener('loadedmetadata', onSeek);
    SUB.handlers = { video, onPlay, onPause, onSeek };
  }

  function unbindSubVideo() {
    const handlers = SUB.handlers;
    if (!handlers) return;
    handlers.video.removeEventListener('play', handlers.onPlay);
    handlers.video.removeEventListener('playing', handlers.onPlay);
    handlers.video.removeEventListener('pause', handlers.onPause);
    handlers.video.removeEventListener('seeked', handlers.onSeek);
    handlers.video.removeEventListener('emptied', handlers.onSeek);
    handlers.video.removeEventListener('timeupdate', syncSubOnce);
    handlers.video.removeEventListener('loadedmetadata', handlers.onSeek);
    SUB.handlers = null;
  }

  function stopSubtitles() {
    stopYouTubeHook();
    if (SUB.cueHandler) {
      const { track, onCue, url } = SUB.cueHandler;
      if (track && onCue) track.removeEventListener('cuechange', onCue);
      if (url) URL.revokeObjectURL(url);
      SUB.cueHandler = null;
    }
    stopSubTick();
    unbindSubVideo();
    SUB.on = false;
    SUB.cues = [];
    SUB.index = -1;
    SUB.pending.clear();
    SUB.layer?.remove();
    SUB.layer = null;
    SUB.video = null;
    SUB.mode = null;
    document.documentElement.classList.remove('ot-sub-on', 'ot-sub-ythook');
  }

  async function startSubtitles(manual = false) {
    if (SUB.loading) return;
    // YouTube: prefer hooking the player's native caption window (immersive
    // style) -- the original stays native and we only add the translation.
    // Falls back to the injected-track path when captions cannot be turned on.
    if (isYouTube()) {
      if (startYouTubeHook()) {
        SUB.on = true;
        SUB.mode = 'ythook';
        document.documentElement.classList.add('ot-sub-on', 'ot-sub-ythook');
        return;
      }
      // hook failed; fall through to injected-track mode below
    }
    const video = SUB.video || findMainVideo();
    if (!video) {
      if (manual) toast('当前页面没有可用的视频');
      return;
    }
    SUB.video = video;
    SUB.on = true;
    SUB.mode = 'track';
    ensureLayer();
    applySubtitleStyle();
    positionSubLayer();
    document.documentElement.classList.add('ot-sub-on');

    SUB.loading = true;
    try {
      let cues = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          cues = await loadCues(video);
        } catch (error) {
          if (attempt === 2) throw error;
          cues = [];
        }
        if (cues.length || !SUB.on) break;
        // YouTube publishes captionTracks asynchronously, so the first attempt
        // can run before the player response exists. Retrying beats declaring
        // "no subtitles here" and never trying again for the rest of the video.
        if (!isYouTube()) break;
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
      }
      if (!SUB.on) return;
      if (!cues.length) {
        if (manual) toast(isYouTube() ? '这个视频没有可用字幕' : '没有找到字幕轨');
        stopSubtitles();
        return;
      }
      const ok = await startCueDriver(video, cues);
      if (!ok) {
        toast('字幕轨加载失败');
        stopSubtitles();
        return;
      }
      // Belt-and-suspenders: the injected track normally drives the overlay via
      // `cuechange`, but some players/browsers fail to emit it (or stop after
      // the first cue). Bind the rAF + timeupdate + watchdog drivers too so the
      // cue keeps advancing off `video.currentTime` even if `cuechange` stalls.
      bindSubVideo(video);
      if (!video.paused) startSubTick();
    } catch (error) {
      toast(`字幕加载失败：${error.message}`);
      stopSubtitles();
    } finally {
      SUB.loading = false;
    }
  }

  function toggleSubtitles() {
    if (SUB.on) {
      SUB.userOff = true;
      stopSubtitles();
      toast('已关闭双语字幕');
    } else {
      SUB.userOff = false;
      startSubtitles(true);
    }
  }

  document.addEventListener('play', event => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    if (!settings.subtitles.enabled || SUB.on || SUB.userOff) return;
    if (SUB.video && SUB.video !== event.target) return;
    startSubtitles();
  }, true);

  window.addEventListener('resize', () => positionSubLayer());
  document.addEventListener('fullscreenchange', () => positionSubLayer());
  document.addEventListener('scroll', () => positionSubLayer(), { passive: true, capture: true });
  document.addEventListener('yt-navigate-finish', () => {
    if (!settings.subtitles.enabled || SUB.userOff || !SUB.on) return;
    stopSubtitles();
    startSubtitles();
  });

  // ---------------------------------------------------------------- appearance

  const MODES = ['bilingual', 'translation', 'hover'];

  function applyAppearance() {
    const root = document.documentElement;
    root.classList.remove(...PRESETS.map(([id]) => `ot-preset-${id}`), ...MODES.map(id => `ot-mode-${id}`));
    root.classList.add(`ot-preset-${settings.style.preset}`, `ot-mode-${settings.displayMode}`);

    const style = settings.style;
    const vars = {
      '--ot-fs': String(style.fontSize / 100),
      '--ot-lh': String(style.lineHeight),
      '--ot-fw': String(style.fontWeight),
      '--ot-op': String(style.opacity / 100),
      '--ot-color': style.colorMode === 'custom' ? style.color : 'inherit',
      '--ot-accent': style.accent,
      '--ot-bg': hexToRgba(style.background, 0.1),
      '--ot-accent-line': hexToRgba(style.background, 0.32),
      '--ot-radius': `${style.radius}px`,
      '--ot-px': `${style.paddingX}px`,
      '--ot-py': `${style.paddingY}px`,
      '--ot-mt': `${style.marginTop}px`,
      '--ot-mb': `${style.marginBottom}px`
    };
    for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
    if (ui) ui.dock.style.display = settings.ui.showFloatingButton ? 'flex' : 'none';
  }

  // ---------------------------------------------------------------- page walking

  function contentRoots() {
    const selectors = SITE_RULES[host] || ['article', 'main', '[role="main"]'];
    const found = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
    return found.length ? found : [document.body];
  }

  function collectBlocks(root) {
    const candidates = [...root.querySelectorAll(BLOCK_SELECTOR)].filter(el => {
      if (el.closest(SKIP)) return false;
      if (el.querySelector(`[${MARK}]`)) return false;
      if (el.nextElementSibling?.hasAttribute(MARK)) return false;
      if (el.querySelector('p,li,blockquote')) return false;
      if (!el.getClientRects().length && el.offsetParent === null) return false;
      return clean(el.innerText || el.textContent).length >= 2;
    });
    if (candidates.length) return candidates;
    return [...root.querySelectorAll('div,span')].filter(el => {
      if (el.closest(SKIP) || el.children.length > 2) return false;
      const text = clean(el.innerText || '');
      return text.length >= 20 && !el.querySelector(BLOCK_SELECTOR);
    });
  }

  function mountTranslation(el) {
    const node = document.createElement('div');
    node.className = 'ot-translation ot-pending';
    node.setAttribute(MARK, 'translation');
    node.textContent = '翻译中…';

    if (settings.displayMode === 'translation') {
      originalHtml.set(el, el.innerHTML);
      el.innerHTML = '';
      el.append(node);
    } else if (INNER_HOSTS.includes(el.tagName)) {
      el.append(node);
    } else {
      el.insertAdjacentElement('afterend', node);
    }

    if (settings.displayMode === 'hover') {
      node.classList.add('ot-hover-hidden');
      const show = () => node.classList.add('ot-hover-visible');
      const hide = () => node.classList.remove('ot-hover-visible');
      el.addEventListener('mouseenter', show);
      el.addEventListener('mouseleave', hide);
      node.addEventListener('mouseenter', show);
      node.addEventListener('mouseleave', hide);
    }
    return node;
  }

  function settle(node, text, error) {
    if (!node?.isConnected) return;
    node.classList.remove('ot-pending');
    if (error) {
      node.textContent = `翻译失败：${error}`;
      node.classList.add('ot-error');
    } else {
      node.textContent = text;
    }
  }

  function pump() {
    if (!active) return;
    while (inflight < settings.concurrency && queue.length) {
      const batch = queue.splice(0, Math.max(1, settings.batchSize));
      inflight += 1;
      requestTranslation(batch.map(item => item.text))
        .then(texts => batch.forEach((item, index) => settle(item.node, texts[index], texts[index] ? null : '空译文')))
        .catch(error => batch.forEach(item => settle(item.node, null, error?.message || '未知错误')))
        .finally(() => {
          inflight -= 1;
          pump();
        });
    }
  }

  function enqueue(el) {
    if (!active || translating.has(el)) return;
    const text = clean(el.innerText || el.textContent);
    if (!text) return;
    translating.add(el);
    queue.push({ el, node: mountTranslation(el), text });
    pump();
  }

  // Lazy, viewport-driven translation. Instead of translating the whole page
  // the moment it is enabled, we collect every block into `pending` and only
  // translate the ones the reader is about to see. This mirrors Immersive
  // Translate's "translate as you scroll" model and avoids firing hundreds of
  // requests at once, which trips engine rate limits and risk control.
  //
  // An IntersectionObserver is the primary trigger. It is not guaranteed to
  // fire in every environment (some webviews throttle it, and it is inert under
  // headless virtual time), so a throttled scroll/resize bounding-rect check
  // acts as a fallback. Both paths funnel through `pending`, so a block is
  // never translated twice.
  function ensureIntersectionObserver() {
    if (intersectionObserver || typeof IntersectionObserver === 'undefined') return intersectionObserver;
    intersectionObserver = new IntersectionObserver(entries => {
      if (!active) return;
      lastIoAt = Date.now();
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        intersectionObserver.unobserve(el);
        if (pending.delete(el)) enqueue(el);
      }
    }, { rootMargin: LAZY_ROOT_MARGIN, threshold: 0 });
    return intersectionObserver;
  }

  const inViewport = (el, margin) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
  };

  function flushVisible() {
    if (!active || !pending.size) return;
    for (const el of [...pending]) {
      if (!el.isConnected) {
        pending.delete(el);
        continue;
      }
      if (!inViewport(el, LAZY_MARGIN_PX)) continue;
      pending.delete(el);
      intersectionObserver?.unobserve(el);
      enqueue(el);
    }
  }

  function scheduleFlush() {
    if (Date.now() - lastIoAt < 500) return; // observer delivered recently
    if (flushScheduled) return;
    flushScheduled = true;
    // requestAnimationFrame is inert in some embedded webviews (and under
    // headless virtual time), which is exactly the situation this fallback
    // exists for, so drive it from a plain timer rather than the compositor.
    setTimeout(() => {
      flushScheduled = false;
      flushVisible();
    }, 16);
  }

  function watchViewport() {
    addEventListener('scroll', scheduleFlush, { passive: true, capture: true });
    addEventListener('resize', scheduleFlush, { passive: true });
  }

  function scan(root = document) {
    if (!active) return;
    const targets = root === document ? contentRoots().flatMap(collectBlocks) : collectBlocks(root);
    const io = ensureIntersectionObserver();
    for (const el of targets) {
      if (translating.has(el) || pending.has(el)) continue;
      pending.add(el);
      if (io) io.observe(el);
    }
    scheduleFlush();
  }

  function restore() {
    active = false;
    queue.length = 0;
    pending.clear();
    intersectionObserver?.disconnect();
    lastIoAt = 0;
    for (const [el, html] of originalHtml) {
      if (el.isConnected) el.innerHTML = trustedHtml(html);
    }
    originalHtml.clear();
    document.querySelectorAll(`[${MARK}]`).forEach(node => node.remove());
    translating = new WeakSet();
    updatePanel();
  }

  function start() {
    if (active) return;
    if (settings.siteRules.blacklist.some(matchesSite)) {
      toast('当前站点在排除列表中，已跳过翻译');
      return;
    }
    active = true;
    updatePanel();
    scan(document);
    // Translate the above-the-fold blocks right away instead of waiting for
    // the observer / next scroll tick.
    flushVisible();
  }

  const toggle = () => (active ? restore() : start());

  function observe() {
    observer?.disconnect();
    observer = new MutationObserver(records => {
      if (!active || !document.body) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || node.hasAttribute?.(MARK)) continue;
          scan(node);
        }
      }
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------- selection bubble

  function closeBubble() {
    bubble?.remove();
    bubble = null;
  }

  async function translateSelection() {
    const selection = getSelection();
    const text = clean(selection?.toString() || '');
    if (!text) {
      toast('请先选中一段文本');
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    closeBubble();
    bubble = document.createElement('div');
    bubble.className = 'ot-bubble';
    bubble.textContent = '翻译中…';
    bubble.style.top = `${Math.min(window.innerHeight - 90, rect.bottom) + window.scrollY + 8}px`;
    bubble.style.left = `${Math.max(8, Math.min(window.innerWidth - 340, rect.left)) + window.scrollX}px`;
    document.body.append(bubble);
    try {
      const [result] = await requestTranslation([text.slice(0, 4000)]);
      if (bubble) bubble.textContent = result || '没有可显示的译文';
    } catch (error) {
      if (bubble) {
        bubble.textContent = `翻译失败：${error.message}`;
        bubble.classList.add('ot-error');
      }
    }
  }

  document.addEventListener('mousedown', event => {
    if (bubble && !bubble.contains(event.target)) closeBubble();
  });

  function toast(message) {
    const node = document.createElement('div');
    node.className = 'ot-toast';
    node.textContent = message;
    document.body.append(node);
    setTimeout(() => node.remove(), 2600);
  }

  // ---------------------------------------------------------------- UI (shadow DOM)

  let ui = null;

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
    .dock { position: fixed; display: flex; flex-direction: column; align-items: center; gap: 6px;
      width: 44px; z-index: 2147483647; }
    .dock.snapping { transition: left .24s cubic-bezier(.22,.61,.36,1), top .24s ease; }
    .gear { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0;
      border: 0; border-radius: 50%; background: rgba(24,24,32,.9); color: rgba(255,255,255,.88);
      font-size: 18px; line-height: 1; box-shadow: 0 6px 18px rgba(0,0,0,.28); backdrop-filter: blur(6px);
      opacity: .85; cursor: pointer; transition: opacity .15s ease, transform .15s ease, background .15s ease; }
    .gear:hover { opacity: 1; transform: scale(1.08); background: #2a2a38; }
    .ball { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0;
      border: 0; border-radius: 50%; background: linear-gradient(140deg,#7d6dff,#5b4ae8); color: #fff;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; letter-spacing: .02em;
      box-shadow: 0 6px 18px rgba(0,0,0,.28); cursor: grab; user-select: none; touch-action: none;
      transition: background .2s ease, transform .15s ease, box-shadow .2s ease; }
    .ball:hover { transform: scale(1.06); box-shadow: 0 8px 22px rgba(0,0,0,.34); }
    .dock.dragging .ball { cursor: grabbing; transform: scale(1.04); }
    .dock.active .ball { background: linear-gradient(140deg,#4a4763,#2f2d42); }
    .overlay { position: fixed; inset: 0; background: rgba(12,12,18,.55); display: flex; align-items: center;
      justify-content: center; z-index: 2147483646; backdrop-filter: blur(2px); }
    .dialog { width: min(720px, 92vw); max-height: 84vh; display: flex; flex-direction: column; overflow: hidden;
      border-radius: 16px; background: #fff; color: #1b1b2a; box-shadow: 0 24px 70px rgba(0,0,0,.35); }
    .head { display: flex; align-items: center; gap: 10px; padding: 16px 20px 12px; }
    .head h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .head .ver { font-size: 11px; color: #8b8b9e; }
    .close { margin-left: auto; border: 0; background: transparent; font-size: 18px; cursor: pointer; color: #6d6e80; line-height: 1; }
    .tabs { display: flex; gap: 4px; padding: 0 16px 12px; border-bottom: 1px solid #e7e7f0; }
    .tab { border: 0; background: transparent; padding: 6px 12px; border-radius: 8px; font-size: 13px;
      color: #6d6e80; cursor: pointer; }
    .tab.active { background: rgba(109,93,252,.12); color: #4a3ddb; font-weight: 600; }
    .body { padding: 16px 20px; overflow-y: auto; }
    .pane { display: none; }
    .pane.active { display: block; }
    .field { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
    .field.col { display: block; }
    .field[hidden] { display: none; }
    .field > label:not(.switch) { flex: 0 0 118px; font-size: 13px; color: #6d6e80; }
    .field.col > label { display: block; margin-bottom: 6px; flex: none; }
    .field input[type=text], .field input[type=password], .field select, .field textarea {
      flex: 1 1 auto; min-width: 0; padding: 8px 10px; border: 1px solid #e7e7f0; border-radius: 8px;
      font-size: 13px; background: #fff; color: inherit; outline: none; }
    .field textarea { width: 100%; resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.6; }
    .field input:focus, .field select:focus, .field textarea:focus { border-color: #6d5dfc; box-shadow: 0 0 0 3px rgba(109,93,252,.12); }
    .field input[type=range] { flex: 1 1 auto; height: 20px; accent-color: #6d5dfc; }
    .hint { font-size: 11.5px; color: #8b8b9e; margin: -6px 0 12px; line-height: 1.5; }
    .presets { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
    .preset { border: 1px solid #e7e7f0; border-radius: 10px; padding: 8px 6px; background: #fff; font-size: 12px;
      cursor: pointer; text-align: center; color: inherit; }
    .preset.active { border-color: #6d5dfc; box-shadow: 0 0 0 3px rgba(109,93,252,.14); }
    .seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; border: 1px solid #e7e7f0;
      border-radius: 9px; background: #fafaff; flex: 1 1 auto; }
    .seg button { border: 0; background: transparent; padding: 6px 0; border-radius: 6px; font-size: 12px;
      color: #6d6e80; cursor: pointer; }
    .seg button.active { background: #6d5dfc; color: #fff; font-weight: 600; }
    .switch { position: relative; width: 40px; height: 24px; flex: 0 0 auto; margin-left: auto; }
    .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
    .switch i { position: absolute; inset: 0; border-radius: 999px; background: #dcdce6; transition: background .16s; }
    .switch i::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
      border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); transition: transform .16s; }
    .switch input:checked + i { background: #6d5dfc; }
    .switch input:checked + i::after { transform: translateX(16px); }
    .row-actions { display: flex; align-items: center; gap: 10px; margin: 6px 0 12px; }
    .btn { border: 1px solid #e7e7f0; background: #fff; color: inherit; padding: 6px 12px; border-radius: 8px;
      font-size: 12.5px; cursor: pointer; }
    .btn:hover { border-color: #6d5dfc; color: #4a3ddb; }
    .btn.primary { background: #6d5dfc; border-color: #6d5dfc; color: #fff; font-weight: 600; }
    .status { font-size: 12px; color: #8b8b9e; }
    .status.ok { color: #1a7f37; }
    .status.bad { color: #d92d20; }
    .footer { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-top: 1px solid #e7e7f0; }
    .footer .note { font-size: 11.5px; color: #8b8b9e; flex: 1 1 auto; }
    @media (prefers-color-scheme: dark) {
      .dialog { background: #17171f; color: #ececf3; }
      .tabs, .footer { border-color: #2a2a37; }
      .field input[type=text], .field input[type=password], .field select, .field textarea {
        background: #101018; border-color: #2a2a37; color: #ececf3; }
      .field input[type=color] { border-color: #2a2a37; }
      .tab { color: #9a9aad; }
      .tab.active { background: rgba(139,125,255,.18); color: #b0a6ff; }
      .close { color: #9a9aad; }
      .field > label:not(.switch) { color: #9a9aad; }
      .hint { color: #8b8b9e; }
      .preset { border-color: #2a2a37; background: #101018; color: #ececf3; }
      .preset.active { border-color: #8b7dff; }
      .seg { background: #101018; border-color: #2a2a37; }
      .seg button { color: #9a9aad; }
      .seg button.active { background: #8b7dff; color: #fff; }
      .switch i { background: #3a3a48; }
      .switch input:checked + i { background: #8b7dff; }
      .btn { background: #101018; border-color: #2a2a37; color: #ececf3; }
      .btn.primary { background: #8b7dff; border-color: #8b7dff; color: #fff; }
      .field input[type=range] { accent-color: #8b7dff; }
    }
  `;

  function buildUi() {
    const host = document.createElement('div');
    host.id = 'ot-ui-host';
    host.style.cssText = 'position:fixed;width:0;height:0;right:0;bottom:0;z-index:2147483647;';
    document.documentElement.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    shadow.append(style);

    const dock = document.createElement('div');
    dock.className = 'dock';
    dock.innerHTML = trustedHtml(
      '<button class="gear" type="button" aria-label="设置">⚙</button>' +
        '<button class="ball" type="button"></button>'
    );
    shadow.append(dock);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.style.display = 'none';
    shadow.append(overlay);

    dock.querySelector('.gear').addEventListener('click', openSettings);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) overlay.style.display = 'none';
    });

    ui = { host, shadow, dock, overlay };
    bindDock();
    placeDock();
    updatePanel();
  }

  function dockPosition() {
    const stored = settings.ui.dock || {};
    return {
      side: stored.side === 'left' ? 'left' : 'right',
      top: typeof stored.top === 'number' ? stored.top : 0.68
    };
  }

  const clampValue = (value, min, max) => Math.min(max, Math.max(min, value));

  const dockHeight = () => (ui?.dock ? ui.dock.offsetHeight || 94 : 94);

  function placeDock() {
    if (!ui) return;
    const { side, top } = dockPosition();
    const height = dockHeight();
    ui.dock.dataset.side = side;
    ui.dock.style.left = `${side === 'left' ? 10 : window.innerWidth - 54}px`;
    ui.dock.style.top = `${clampValue(top * window.innerHeight - height / 2, 8, window.innerHeight - height - 8)}px`;
  }

  function bindDock() {
    const ball = ui.dock.querySelector('.ball');
    let dragging = false;
    let moved = false;
    let suppressClick = false;
    let startX = 0;
    let startY = 0;
    let grabX = 0;
    let grabY = 0;

    ball.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const rect = ui.dock.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      grabX = event.clientX - rect.left;
      grabY = event.clientY - rect.top;
      ui.dock.classList.add('dragging');
      ui.dock.classList.remove('snapping');
      ball.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    ball.addEventListener('pointermove', event => {
      if (!dragging) return;
      if (!moved && Math.hypot(event.clientX - startX, event.clientY - startY) < 4) return;
      moved = true;
      const height = dockHeight();
      ui.dock.style.left = `${clampValue(event.clientX - grabX, 6, window.innerWidth - 50)}px`;
      ui.dock.style.top = `${clampValue(event.clientY - grabY, 6, window.innerHeight - height - 6)}px`;
    });

    const release = () => {
      if (!dragging) return;
      dragging = false;
      ui.dock.classList.remove('dragging');
      if (!moved) return;
      const rect = ui.dock.getBoundingClientRect();
      const height = rect.height;
      const side = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
      const top = clampValue((rect.top + height / 2) / window.innerHeight, 0.08, 0.92);
      settings.ui.dock = { side, top };
      persist();
      ui.dock.dataset.side = side;
      ui.dock.classList.add('snapping');
      ui.dock.style.left = `${side === 'left' ? 10 : window.innerWidth - 54}px`;
      ui.dock.style.top = `${clampValue(top * window.innerHeight - height / 2, 8, window.innerHeight - height - 8)}px`;
      setTimeout(() => ui.dock.classList.remove('snapping'), 280);
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 350);
    };

    ball.addEventListener('pointerup', release);
    ball.addEventListener('pointercancel', release);

    ball.addEventListener('click', event => {
      event.preventDefault();
      if (suppressClick) return;
      toggle();
    });
    window.addEventListener('resize', placeDock);
  }

  function updatePanel() {
    if (!ui) return;
    const ball = ui.dock.querySelector('.ball');
    const gear = ui.dock.querySelector('.gear');
    ui.dock.classList.toggle('active', active);
    ball.textContent = active ? '还原' : '翻译';
    ball.title = active ? '还原原文' : '翻译此页';
    ball.setAttribute('aria-label', active ? '还原原文' : '翻译此页');
    gear.title = `设置 · 当前引擎：${ENGINE_SHORT[settings.engine] || settings.engine}`;
    ui.dock.style.display = settings.ui.showFloatingButton ? 'flex' : 'none';
    placeDock();
  }

  function renderSettings() {
    const engine = settings.engine;
    const fields = ENGINE_FIELDS[engine] || [];
    const config = settings.engines[engine] || {};

    const fieldHtml = fields
      .map(field => {
        const depends = field.dependsOn ? ` data-depends="${field.dependsOn}"` : '';
        const hidden = field.dependsOn && !config[field.dependsOn] ? ' hidden' : '';
        if (field.type === 'switch') {
          return `<div class="field"${depends}${hidden}><label>${field.label}</label><label class="switch"><input type="checkbox" data-k="engines.${engine}.${field.key}" ${config[field.key] ? 'checked' : ''}><i></i></label></div>`;
        }
        const value = escapeHtml(config[field.key] ?? '');
        return `<div class="field"${depends}${hidden}><label>${field.label}</label><input type="${field.type === 'password' ? 'password' : 'text'}" data-k="engines.${engine}.${field.key}" value="${value}" placeholder="${field.placeholder || ''}" spellcheck="false" autocomplete="off"></div>`;
      })
      .join('');

    ui.overlay.innerHTML = trustedHtml(`
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="head">
          <h2>Open Translate 设置</h2>
          <span class="ver">v0.3.0</span>
          <button class="close" type="button" aria-label="关闭">✕</button>
        </div>
        <div class="tabs">
          <button class="tab active" data-tab="general" type="button">通用</button>
          <button class="tab" data-tab="style" type="button">样式</button>
          <button class="tab" data-tab="engine" type="button">引擎</button>
          <button class="tab" data-tab="ai" type="button">AI</button>
          <button class="tab" data-tab="subtitles" type="button">字幕</button>
        </div>
        <div class="body">
          <div class="pane active" data-pane="general">
            <div class="field"><label>翻译引擎</label><select data-k="engine">${Object.entries(ENGINE_NAMES)
              .map(([id, name]) => `<option value="${id}" ${id === engine ? 'selected' : ''}>${name}</option>`)
              .join('')}</select></div>
            <div class="field"><label>目标语言</label><select data-k="targetLanguage">${LANGUAGES.map(
              ([code, label]) => `<option value="${code}" ${code === settings.targetLanguage ? 'selected' : ''}>${label}</option>`
            ).join('')}</select></div>
            <div class="field"><label>显示模式</label><div class="seg">${[
              ['bilingual', '双语对照'], ['translation', '仅译文'], ['hover', '悬停显示']
            ].map(([id, name]) => `<button type="button" data-mode="${id}" class="${settings.displayMode === id ? 'active' : ''}">${name}</button>`).join('')}</div></div>
            <div class="field"><label>打开页面自动翻译</label><label class="switch"><input type="checkbox" data-k="autoTranslate" ${settings.autoTranslate ? 'checked' : ''}><i></i></label></div>
            <div class="field"><label>显示悬浮按钮</label><label class="switch"><input type="checkbox" data-k="ui.showFloatingButton" ${settings.ui.showFloatingButton ? 'checked' : ''}><i></i></label></div>
            <div class="field"><label>屏蔽敏感信息</label><label class="switch"><input type="checkbox" data-k="privacy.maskSensitive" ${settings.privacy.maskSensitive ? 'checked' : ''}><i></i></label></div>
            <div class="field"><label>翻译缓存</label><span data-cache-count style="margin-left:auto;font-size:12px;color:#8b8b9e">${cacheCount()} 条</span><button class="btn" type="button" data-clear-cache>清空</button></div>
            <p class="hint">邮箱、电话与常见 API Token 会在发送前替换为占位符，返回后还原。快捷键：Alt+T 翻译 / 还原，Alt+Shift+T 翻译选中文本。</p>
          </div>

          <div class="pane" data-pane="style">
            <div class="presets">${PRESETS.map(
              ([id, name]) => `<button type="button" class="preset ${settings.style.preset === id ? 'active' : ''}" data-preset="${id}">${name}</button>`
            ).join('')}</div>
            <div class="field"><label>字号 ${settings.style.fontSize}%</label><input type="range" data-k="style.fontSize" min="60" max="160" step="5" value="${settings.style.fontSize}"></div>
            <div class="field"><label>行高 ${Number(settings.style.lineHeight).toFixed(2)}</label><input type="range" data-k="style.lineHeight" min="1" max="2.4" step="0.05" value="${settings.style.lineHeight}"></div>
            <div class="field"><label>不透明度 ${settings.style.opacity}%</label><input type="range" data-k="style.opacity" min="30" max="100" step="5" value="${settings.style.opacity}"></div>
            <div class="field"><label>主题色</label><input type="color" data-k="style.accent" value="${settings.style.accent}" style="width:44px;height:30px;padding:2px;border:1px solid #e7e7f0;border-radius:8px;background:transparent"></div>
            <div class="field"><label>背景色</label><input type="color" data-k="style.background" value="${settings.style.background}" style="width:44px;height:30px;padding:2px;border:1px solid #e7e7f0;border-radius:8px;background:transparent"></div>
          </div>

          <div class="pane" data-pane="engine">
            <div class="field"><label>当前引擎</label><strong style="font-size:13px">${ENGINE_NAMES[engine]}</strong></div>
            ${fieldHtml || '<p class="hint">这个引擎不需要密钥，开箱即用。</p>'}
            <div class="row-actions">
              <button class="btn" type="button" data-test>测试连接</button>
              <span class="status" data-status></span>
            </div>
            <p class="hint">密钥只保存在本机（GM 存储），不会上传到任何第三方服务器；请求直接从浏览器发往对应的翻译服务。</p>
          </div>

          <div class="pane" data-pane="ai">
            <div class="field col"><label>提示词模板</label><textarea data-k="ai.prompt" rows="6" spellcheck="false">${escapeHtml(settings.ai.prompt)}</textarea></div>
            <p class="hint">可用变量 {{target}}、{{source}}。仅在 OpenAI / DeepSeek / Gemini / Claude 引擎下生效。</p>
            <div class="field col"><label>术语表</label><textarea data-k="ai.glossary" rows="4" spellcheck="false" placeholder="prompt = 提示词">${escapeHtml(settings.ai.glossary)}</textarea></div>
            <div class="field"><label>温度 ${Number(settings.ai.temperature).toFixed(1)}</label><input type="range" data-k="ai.temperature" min="0" max="1" step="0.1" value="${settings.ai.temperature}"></div>
          </div>

          <div class="pane" data-pane="subtitles">
            <div class="field"><label>启用双语字幕</label><label class="switch"><input type="checkbox" data-k="subtitles.enabled" ${settings.subtitles.enabled ? 'checked' : ''}><i></i></label></div>
            <div class="field"><label>显示方式</label><div class="seg">${[
              ['bilingual', '双语'], ['translation', '仅译文']
            ].map(([id, name]) => `<button type="button" data-sub-mode="${id}" class="${settings.subtitles.mode === id ? 'active' : ''}">${name}</button>`).join('')}</div></div>
            <div class="field"><label>字号 ${settings.subtitles.fontSize}%</label><input type="range" data-k="subtitles.fontSize" min="60" max="200" step="5" value="${settings.subtitles.fontSize}"></div>
            <div class="field"><label>距底部 ${settings.subtitles.position}%</label><input type="range" data-k="subtitles.position" min="2" max="45" step="1" value="${settings.subtitles.position}"></div>
            <div class="field"><label>背景衬底</label><label class="switch"><input type="checkbox" data-k="subtitles.background" ${settings.subtitles.background ? 'checked' : ''}><i></i></label></div>
            <div class="field"><label>快捷键</label><input type="text" data-k="subtitles.shortcut" value="${escapeHtml(settings.subtitles.shortcut)}" spellcheck="false" autocomplete="off"></div>
            <div class="row-actions">
              <button class="btn" type="button" data-sub-toggle>在本页开关字幕</button>
              <span class="status" data-sub-status></span>
            </div>
            <p class="hint">支持 YouTube 字幕轨与页面里的 &lt;track&gt; 元素。开启后视频开始播放时自动加载，译文同样走翻译缓存。</p>
          </div>
        </div>
        <div class="footer">
          <span class="note">改动即时生效并保存在本机</span>
          <button class="btn" type="button" data-reset>恢复默认</button>
          <button class="btn" type="button" data-export>导出</button>
          <button class="btn" type="button" data-import>导入</button>
          <button class="btn primary" type="button" data-close>完成</button>
          <input type="file" accept="application/json" data-file hidden>
        </div>
      </div>
    `);

    bindSettingsUi();
  }

  function syncFieldDeps() {
    ui.overlay.querySelectorAll('[data-depends]').forEach(field => {
      const toggle = ui.overlay.querySelector(`[data-k="engines.${settings.engine}.${field.dataset.depends}"]`);
      field.hidden = !(toggle && toggle.checked);
    });
  }

  function activateTab(name) {
    ui.overlay.querySelectorAll('.tab').forEach(node => node.classList.toggle('active', node.dataset.tab === name));
    ui.overlay.querySelectorAll('.pane').forEach(pane => pane.classList.toggle('active', pane.dataset.pane === name));
  }

  function bindSettingsUi() {
    const root = ui.overlay;

    root.querySelector('.close').addEventListener('click', closeSettings);
    root.querySelector('[data-close]').addEventListener('click', closeSettings);

    root.querySelector('[data-reset]').addEventListener('click', () => {
      if (!confirm('恢复默认设置？当前配置会被覆盖。')) return;
      settings = structuredClone(DEFAULTS);
      persist();
      applyAppearance();
      renderSettings();
      updatePanel();
      toast('已恢复默认设置');
    });

    root.querySelector('[data-export]').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `open-translate-settings-${new Date().toISOString().slice(0, 10)}.json`;
      root.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('配置已导出');
    });

    const fileInput = root.querySelector('[data-file]');
    root.querySelector('[data-import]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const next = structuredClone(DEFAULTS);
        deepMerge(next, parsed);
        settings = next;
        persist();
        applyAppearance();
        renderSettings();
        updatePanel();
        toast('配置已导入');
      } catch {
        toast('导入失败：不是有效的配置文件');
      } finally {
        fileInput.value = '';
      }
    });

    root.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    });

    root.querySelector('[data-clear-cache]').addEventListener('click', event => {
      clearTranslationCache();
      const label = event.currentTarget.closest('.field').querySelector('[data-cache-count]');
      if (label) label.textContent = '0 条';
      toast('翻译缓存已清空');
    });

    // Scoped to [data-mode]: the subtitle pane reuses the same .seg markup.
    root.querySelectorAll('.seg button[data-mode]').forEach(button => {
      button.addEventListener('click', () => {
        settings.displayMode = button.dataset.mode;
        persist();
        applyAppearance();
        root.querySelectorAll('.seg button[data-mode]').forEach(node => node.classList.toggle('active', node === button));
      });
    });

    root.querySelectorAll('.seg button[data-sub-mode]').forEach(button => {
      button.addEventListener('click', () => {
        settings.subtitles.mode = button.dataset.subMode;
        persist();
        applySubtitleStyle();
        root.querySelectorAll('.seg button[data-sub-mode]').forEach(node => node.classList.toggle('active', node === button));
      });
    });

    const subToggle = root.querySelector('[data-sub-toggle]');
    if (subToggle) {
      subToggle.addEventListener('click', () => {
        toggleSubtitles();
        const status = root.querySelector('[data-sub-status]');
        if (status) status.textContent = SUB.on ? '本页已开启' : '本页已关闭';
      });
    }

    root.querySelectorAll('.preset').forEach(button => {
      button.addEventListener('click', () => {
        settings.style.preset = button.dataset.preset;
        persist();
        applyAppearance();
        root.querySelectorAll('.preset').forEach(node => node.classList.toggle('active', node === button));
      });
    });

    root.querySelectorAll('[data-k]').forEach(input => {
      const path = input.dataset.k;
      const eventName = input.tagName === 'SELECT' || input.type === 'checkbox' || input.type === 'color' ? 'change' : 'input';
      input.addEventListener(eventName, () => {
        let value;
        if (input.type === 'checkbox') value = input.checked;
        else if (input.type === 'range') value = Number(input.value);
        else value = input.value;
        setPath(settings, path, value);
        persist();
        applyAppearance();
        if (path.startsWith('subtitles.')) {
          applySubtitleStyle();
          positionSubLayer();
          const label = input.previousElementSibling;
          if (label && path === 'subtitles.fontSize') label.textContent = `字号 ${value}%`;
          if (label && path === 'subtitles.position') label.textContent = `距底部 ${value}%`;
          if (path === 'subtitles.enabled' && !value) stopSubtitles();
        }
        if (path === 'engine') {
          updatePanel();
          renderSettings();
          activateTab('engine');
        } else if (path.startsWith('engines.')) {
          syncFieldDeps();
        }
        if (path === 'style.fontSize' || path === 'style.lineHeight' || path === 'style.opacity') {
          const label = input.previousElementSibling;
          if (label) {
            const text = { 'style.fontSize': '字号', 'style.lineHeight': '行高', 'style.opacity': '不透明度' }[path];
            const suffix = path === 'style.lineHeight' ? Number(value).toFixed(2) : `${value}%`;
            label.textContent = `${text} ${suffix}`;
          }
        }
      });
    });

    const testButton = root.querySelector('[data-test]');
    if (testButton) {
      testButton.addEventListener('click', async () => {
        const status = root.querySelector('[data-status]');
        status.className = 'status';
        status.textContent = '测试中…';
        testButton.disabled = true;
        try {
          const [sample] = await requestTranslation(['The quick brown fox jumps over the lazy dog.']);
          status.className = 'status ok';
          status.textContent = `成功：${sample}`;
        } catch (error) {
          status.className = 'status bad';
          status.textContent = error?.message || '测试失败';
        } finally {
          testButton.disabled = false;
        }
      });
    }
  }

  function openSettings() {
    if (!ui) buildUi();
    renderSettings();
    ui.overlay.style.display = 'flex';
  }

  function closeSettings() {
    if (ui) ui.overlay.style.display = 'none';
  }

  // ---------------------------------------------------------------- shortcuts

  function matchesSubShortcut(event) {
    const combo = String(settings.subtitles.shortcut || '').toLowerCase();
    if (!combo) return false;
    const parts = combo.split('+').map(part => part.trim()).filter(Boolean);
    const key = parts.pop();
    if (!key) return false;
    if (event.altKey !== parts.includes('alt')) return false;
    if (event.ctrlKey !== parts.includes('ctrl')) return false;
    if (event.shiftKey !== parts.includes('shift')) return false;
    if (event.metaKey !== (parts.includes('meta') || parts.includes('cmd'))) return false;
    return event.code?.toLowerCase() === `key${key}` || event.key?.toLowerCase() === key;
  }

  document.addEventListener('keydown', event => {
    if (matchesSubShortcut(event)) {
      event.preventDefault();
      toggleSubtitles();
      return;
    }
    const isToggle = event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyT';
    if (!isToggle) {
      if (event.key === 'Escape') {
        closeBubble();
        closeSettings();
      }
      return;
    }
    event.preventDefault();
    if (event.shiftKey) translateSelection();
    else toggle();
  });

  // ---------------------------------------------------------------- styles & boot

  function addStyle() {
    const style = document.createElement('style');
    style.textContent = `
      .ot-translation { display: inline-block; max-width: 100%; font-family: inherit;
        font-size: calc(1em * var(--ot-fs, 1)); font-weight: var(--ot-fw, 400); line-height: var(--ot-lh, 1.7);
        color: var(--ot-color, inherit); opacity: var(--ot-op, 1);
        margin: var(--ot-mt, 4px) 0 var(--ot-mb, 12px); padding: var(--ot-py, 2px) var(--ot-px, 8px);
        border-radius: var(--ot-radius, 6px); background: transparent; white-space: pre-wrap;
        overflow-wrap: break-word; transition: background-color .15s ease, filter .18s ease; }
      html.ot-preset-underline .ot-translation { padding-bottom: 3px; border-bottom: 1px dashed var(--ot-accent-line); }
      html.ot-preset-divider .ot-translation { padding-left: 10px; border-left: 2px solid var(--ot-accent-line); }
      html.ot-preset-card .ot-translation { padding: 10px 12px; background: var(--ot-bg); border: 1px solid var(--ot-accent-line); }
      html.ot-preset-quote .ot-translation { padding: 6px 12px; border-left: 4px solid var(--ot-accent); background: var(--ot-bg); }
      html.ot-preset-highlight .ot-translation { padding: 4px 8px; background: var(--ot-bg); }
      html.ot-preset-faded .ot-translation { opacity: calc(var(--ot-op, 1) * .68); }
      html.ot-preset-blur .ot-translation { filter: blur(4px); }
      html.ot-preset-blur .ot-translation:hover { filter: none; }
      .ot-hover-hidden { display: none !important; }
      .ot-hover-visible { display: inline-block !important; }
      .ot-pending { opacity: calc(var(--ot-op, 1) * .55); font-style: italic; }
      .ot-error { color: #d92d20 !important; border-color: rgba(217,45,32,.45) !important; background: rgba(217,45,32,.08) !important; }
      .ot-bubble { position: absolute; z-index: 2147483647; max-width: 340px; padding: 10px 12px; border-radius: 10px;
        background: #1b1b24; color: #f4f4f5; box-shadow: 0 12px 34px rgba(0,0,0,.34);
        font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; white-space: pre-wrap; }
      .ot-toast { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
        padding: 8px 14px; border-radius: 999px; background: rgba(24,24,32,.92); color: #fff;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    `;
    document.documentElement.append(style);
  }

  addStyle();
  applyAppearance();
  buildUi();
  observe();
  watchViewport();

  try {
    GM_registerMenuCommand('Open Translate 设置', openSettings);
    GM_registerMenuCommand('翻译 / 还原当前页面', toggle);
    GM_registerMenuCommand('翻译选中文本', translateSelection);
  } catch {
    /* menu API unavailable */
  }

  if (settings.autoTranslate || settings.siteRules.alwaysTranslate.some(matchesSite)) sleep(400).then(start);
})();
