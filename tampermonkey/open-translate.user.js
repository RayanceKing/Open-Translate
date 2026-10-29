// ==UserScript==
// @name         Open Translate · Bilingual Web Reader
// @namespace    https://github.com/open-translate
// @version      0.2.0
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
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const MARK = 'data-open-translate';
  const SKIP = 'script,style,noscript,textarea,input,select,option,button,code,pre,kbd,samp,svg,canvas,[contenteditable="true"],[data-open-translate]';
  const BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,td,th,dd,dt';
  const INNER_HOSTS = ['LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE'];
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
      { key: 'key', label: '订阅密钥', type: 'password' },
      { key: 'region', label: '区域', type: 'text', placeholder: 'global' }
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
      microsoft: { key: '', region: 'global' },
      libre: { url: '', key: '' },
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
      gemini: { apiKey: '', model: 'gemini-2.0-flash' },
      claude: { apiKey: '', model: 'claude-3-5-haiku-latest' }
    },
    siteRules: { blacklist: [], alwaysTranslate: [] },
    ui: { showFloatingButton: true, dock: { side: 'right', top: 0.68 } }
  };

  let settings = null;
  let active = false;
  let observer = null;
  let inflight = 0;
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
    const next = structuredClone(DEFAULTS);
    if (stored) deepMerge(next, typeof stored === 'string' ? JSON.parse(stored) : stored);
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
      if (!cfg.key) throw new Error('尚未填写 Microsoft 翻译订阅密钥');
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

  async function requestTranslation(texts) {
    const guard = settings.privacy.maskSensitive ? maskAll(texts) : null;
    const payload = guard ? guard.safe : texts;
    const output = await translateBatch(payload, settings.targetLanguage);
    return output.map(value => (guard ? guard.restore(value) : value));
  }

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
    if (ui) ui.dock.style.display = settings.ui.showFloatingButton ? 'block' : 'none';
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

  function scan(root = document) {
    if (!active) return;
    const targets = root === document ? contentRoots().flatMap(collectBlocks) : collectBlocks(root);
    targets.forEach(enqueue);
  }

  function restore() {
    active = false;
    queue.length = 0;
    for (const [el, html] of originalHtml) {
      if (el.isConnected) el.innerHTML = html;
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
  }

  const toggle = () => (active ? restore() : start());

  function observe() {
    observer?.disconnect();
    observer = new MutationObserver(records => {
      if (!active || !document.body) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || node.hasAttribute?.(MARK)) continue;
          if (queue.length > 80) return;
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
    .dock { position: fixed; width: 44px; height: 44px; z-index: 2147483647; }
    .dock.snapping { transition: left .24s cubic-bezier(.22,.61,.36,1), top .24s ease; }
    .ball { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0;
      border: 0; border-radius: 50%; background: linear-gradient(140deg,#7d6dff,#5b4ae8); color: #fff;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; letter-spacing: .02em;
      box-shadow: 0 6px 18px rgba(0,0,0,.28); cursor: grab; user-select: none; touch-action: none;
      transition: background .2s ease, transform .15s ease, box-shadow .2s ease; }
    .ball:hover { transform: scale(1.06); box-shadow: 0 8px 22px rgba(0,0,0,.34); }
    .dock.dragging .ball { cursor: grabbing; transform: scale(1.04); }
    .dock.active .ball { background: linear-gradient(140deg,#4a4763,#2f2d42); }
    .dock.dragging .menu { display: none; }
    .menu { position: absolute; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 2px;
      padding: 4px; border-radius: 999px; background: rgba(24,24,32,.95); box-shadow: 0 8px 26px rgba(0,0,0,.3);
      backdrop-filter: blur(8px); white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .16s ease; }
    .dock[data-side="right"] .menu { right: calc(100% + 8px); }
    .dock[data-side="left"] .menu { left: calc(100% + 8px); }
    .dock:hover .menu, .dock.open .menu { opacity: 1; pointer-events: auto; }
    .menu button { border: 0; border-radius: 999px; padding: 7px 11px; background: rgba(255,255,255,.1); color: #fff;
      font-size: 13px; cursor: pointer; transition: background .15s ease; }
    .menu button:hover { background: rgba(255,255,255,.22); }
    .menu .main { background: #6d5dfc; font-weight: 600; }
    .dock.active .menu .main { background: #3b3557; }
    .menu .engine { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: rgba(255,255,255,.72); font-size: 12px; }
    .menu .gear { padding: 7px 9px; color: rgba(255,255,255,.72); }
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
    dock.innerHTML =
      '<button class="ball" type="button"></button>' +
      '<div class="menu">' +
      '<button class="main" type="button"></button>' +
      '<button class="engine" type="button" title="翻译引擎，点击打开设置"></button>' +
      '<button class="gear" type="button" title="设置">⚙</button>' +
      '</div>';
    shadow.append(dock);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.style.display = 'none';
    shadow.append(overlay);

    dock.querySelector('.main').addEventListener('click', toggle);
    dock.querySelector('.engine').addEventListener('click', openSettings);
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

  function placeDock() {
    if (!ui) return;
    const { side, top } = dockPosition();
    ui.dock.dataset.side = side;
    ui.dock.style.left = `${side === 'left' ? 10 : window.innerWidth - 54}px`;
    ui.dock.style.top = `${clampValue(top * window.innerHeight, 70, window.innerHeight - 70)}px`;
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
      ui.dock.style.left = `${clampValue(event.clientX - grabX, 6, window.innerWidth - 50)}px`;
      ui.dock.style.top = `${clampValue(event.clientY - grabY, 6, window.innerHeight - 50)}px`;
    });

    const release = () => {
      if (!dragging) return;
      dragging = false;
      ui.dock.classList.remove('dragging');
      if (!moved) return;
      const rect = ui.dock.getBoundingClientRect();
      const side = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
      const top = clampValue((rect.top + rect.height / 2) / window.innerHeight, 0.08, 0.92);
      settings.ui.dock = { side, top };
      persist();
      ui.dock.dataset.side = side;
      ui.dock.classList.add('snapping');
      ui.dock.style.left = `${side === 'left' ? 10 : window.innerWidth - 54}px`;
      ui.dock.style.top = `${clampValue(top * window.innerHeight, 70, window.innerHeight - 70)}px`;
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
    const main = ui.dock.querySelector('.main');
    ui.dock.classList.toggle('active', active);
    ball.textContent = active ? '还原' : '翻译';
    ball.title = active ? '还原原文' : '翻译此页';
    main.textContent = active ? '还原原文' : '翻译此页';
    ui.dock.querySelector('.engine').textContent = ENGINE_SHORT[settings.engine] || settings.engine;
    ui.dock.style.display = settings.ui.showFloatingButton ? 'block' : 'none';
    placeDock();
  }

  function renderSettings() {
    const engine = settings.engine;
    const fields = ENGINE_FIELDS[engine] || [];
    const config = settings.engines[engine] || {};

    const fieldHtml = fields
      .map(field => {
        if (field.type === 'switch') {
          return `<div class="field"><label>${field.label}</label><label class="switch"><input type="checkbox" data-k="engines.${engine}.${field.key}" ${config[field.key] ? 'checked' : ''}><i></i></label></div>`;
        }
        const value = String(config[field.key] ?? '').replace(/"/g, '&quot;');
        return `<div class="field"><label>${field.label}</label><input type="${field.type === 'password' ? 'password' : 'text'}" data-k="engines.${engine}.${field.key}" value="${value}" placeholder="${field.placeholder || ''}" spellcheck="false" autocomplete="off"></div>`;
      })
      .join('');

    ui.overlay.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="head">
          <h2>Open Translate 设置</h2>
          <span class="ver">v0.2.0</span>
          <button class="close" type="button" aria-label="关闭">✕</button>
        </div>
        <div class="tabs">
          <button class="tab active" data-tab="general" type="button">通用</button>
          <button class="tab" data-tab="style" type="button">样式</button>
          <button class="tab" data-tab="engine" type="button">引擎</button>
          <button class="tab" data-tab="ai" type="button">AI</button>
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
            <div class="field col"><label>提示词模板</label><textarea data-k="ai.prompt" rows="6" spellcheck="false">${settings.ai.prompt}</textarea></div>
            <p class="hint">可用变量 {{target}}、{{source}}。仅在 OpenAI / DeepSeek / Gemini / Claude 引擎下生效。</p>
            <div class="field col"><label>术语表</label><textarea data-k="ai.glossary" rows="4" spellcheck="false" placeholder="prompt = 提示词">${settings.ai.glossary}</textarea></div>
            <div class="field"><label>温度 ${Number(settings.ai.temperature).toFixed(1)}</label><input type="range" data-k="ai.temperature" min="0" max="1" step="0.1" value="${settings.ai.temperature}"></div>
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
    `;

    bindSettingsUi();
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

    root.querySelectorAll('.seg button').forEach(button => {
      button.addEventListener('click', () => {
        settings.displayMode = button.dataset.mode;
        persist();
        applyAppearance();
        root.querySelectorAll('.seg button').forEach(node => node.classList.toggle('active', node === button));
      });
    });

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
        if (path === 'engine') {
          updatePanel();
          renderSettings();
          activateTab('engine');
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

  document.addEventListener('keydown', event => {
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

  try {
    GM_registerMenuCommand('Open Translate 设置', openSettings);
    GM_registerMenuCommand('翻译 / 还原当前页面', toggle);
    GM_registerMenuCommand('翻译选中文本', translateSelection);
  } catch {
    /* menu API unavailable */
  }

  if (settings.autoTranslate || settings.siteRules.alwaysTranslate.some(matchesSite)) sleep(400).then(start);
})();
