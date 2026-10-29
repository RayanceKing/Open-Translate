(() => {
  'use strict';

  const MARK = 'data-open-translate';
  const SKIP = 'script,style,noscript,textarea,input,select,option,button,code,pre,kbd,samp,svg,canvas,[contenteditable="true"],[data-open-translate]';
  const BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,td,th,dd,dt';
  const INNER_HOSTS = ['LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE'];
  const ENGINE_SHORT = {
    google: 'Google',
    mymemory: 'MyMemory',
    deepl: 'DeepL',
    microsoft: '微软',
    libre: 'Libre',
    openai: 'OpenAI',
    deepseek: 'DeepSeek',
    gemini: 'Gemini',
    claude: 'Claude'
  };
  const SITE_RULES = {
    'github.com': ['article.markdown-body', '.js-comment-body', '.markdown-body'],
    'reddit.com': ['[data-testid="post-content"]', '[id^="t3_"]', 'shreddit-post'],
    'news.ycombinator.com': ['.titleline', '.commtext'],
    'medium.com': ['article'],
    'substack.com': ['article', '.post-content']
  };

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
      preset: 'underline',
      fontSize: 100,
      lineHeight: 1.7,
      fontWeight: 400,
      opacity: 100,
      colorMode: 'inherit',
      color: '#3f3f46',
      accent: '#6d5dfc',
      background: '#6d5dfc',
      radius: 6,
      paddingX: 8,
      paddingY: 2,
      marginTop: 4,
      marginBottom: 12
    },
    shortcuts: { toggle: 'Alt+T', selection: 'Alt+Shift+T' },
    siteRules: { blacklist: [], alwaysTranslate: [] },
    ui: { showFloatingButton: true, dock: { side: 'right', top: 0.68 } }
  };

  let settings = structuredClone(DEFAULTS);
  let active = false;
  let observer = null;
  let dock = null;
  let dockWriteAt = 0;
  let translating = new WeakSet();
  const queue = [];
  const originalHtml = new Map();
  let inflight = 0;

  // ---------------------------------------------------------------- utilities

  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

  function deepMerge(base, patch) {
    if (!isPlainObject(patch)) return base;
    for (const [key, value] of Object.entries(patch)) {
      if (isPlainObject(value) && isPlainObject(base[key])) deepMerge(base[key], value);
      else if (value !== undefined) base[key] = value;
    }
    return base;
  }

  function hexToRgba(hex, alpha) {
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
    if (!match) return `rgba(109, 93, 252, ${alpha})`;
    const [r, g, b] = match.slice(1).map(part => parseInt(part, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const host = location.hostname.replace(/^www\./, '');
  const matchesSite = pattern => {
    const target = String(pattern).replace(/^\*\.?/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return Boolean(target) && (host === target || host.endsWith(`.${target}`));
  };

  // ---------------------------------------------------------------- appearance

  const PRESETS = ['plain', 'underline', 'divider', 'card', 'quote', 'highlight', 'faded', 'blur'];
  const MODES = ['bilingual', 'translation', 'hover'];

  function applyAppearance() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.remove(...PRESETS.map(id => `ot-preset-${id}`), ...MODES.map(id => `ot-mode-${id}`));
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
  }

  // ---------------------------------------------------------------- settings

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(['settings', 'targetLanguage']);
      const next = structuredClone(DEFAULTS);
      deepMerge(next, stored.settings || {});
      if (!stored.settings && stored.targetLanguage) next.targetLanguage = stored.targetLanguage;
      settings = next;
    } catch {
      /* extension context invalidated: keep the settings we already have */
    }
    return settings;
  }

  // ---------------------------------------------------------------- messaging

  async function requestTranslation(texts) {
    const response = await chrome.runtime.sendMessage({ type: 'translate', texts, target: settings.targetLanguage });
    if (!response) throw new Error('后台没有响应，请重新加载页面');
    if (response.error) throw new Error(response.error);
    return response.texts || [];
  }

  // ---------------------------------------------------------------- DOM walking

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
    // Fallback for div-soup sites without semantic tags.
    return [...root.querySelectorAll('div,span')].filter(el => {
      if (el.closest(SKIP) || el.children.length > 2) return false;
      const text = clean(el.innerText || '');
      return text.length >= 20 && !el.querySelector(BLOCK_SELECTOR);
    });
  }

  // ---------------------------------------------------------------- rendering

  function mountTranslation(el) {
    const node = document.createElement('div');
    node.className = 'ot-translation ot-pending';
    node.setAttribute(MARK, 'translation');
    node.textContent = '翻译中…';

    if (settings.displayMode === 'translation') {
      originalHtml.set(el, el.innerHTML);
      el.innerHTML = '';
      el.append(node);
      el.classList.add('ot-swapped');
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

  // ---------------------------------------------------------------- lifecycle

  function restore() {
    active = false;
    queue.length = 0;
    for (const [el, html] of originalHtml) {
      if (el.isConnected) {
        el.innerHTML = html;
        el.classList.remove('ot-swapped');
      }
    }
    originalHtml.clear();
    document.querySelectorAll(`[${MARK}]`).forEach(node => node.remove());
    translating = new WeakSet();
    renderDock();
  }

  function start() {
    if (active) return;
    if (settings.siteRules.blacklist.some(matchesSite)) {
      toast('当前站点在排除列表中，已跳过翻译');
      return;
    }
    active = true;
    renderDock();
    scan(document);
  }

  function toggle() {
    if (active) restore();
    else start();
  }

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

  // ---------------------------------------------------------------- selection

  let bubble = null;

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

  // ---------------------------------------------------------------- floating dock

  function toast(message) {
    const node = document.createElement('div');
    node.className = 'ot-toast';
    node.textContent = message;
    document.body.append(node);
    setTimeout(() => node.remove(), 2600);
  }

  function openOptions() {
    chrome.runtime.sendMessage({ type: 'open-options' }).catch(() => {});
  }

  function dockPosition() {
    const stored = settings.ui.dock || {};
    return {
      side: stored.side === 'left' ? 'left' : 'right',
      top: typeof stored.top === 'number' ? stored.top : 0.68
    };
  }

  function dockHeight() {
    return dock ? dock.offsetHeight || 82 : 82;
  }

  function applyDockPosition() {
    if (!dock) return;
    const { side, top } = dockPosition();
    const height = dockHeight();
    dock.dataset.side = side;
    dock.style.left = `${side === 'left' ? 10 : window.innerWidth - 54}px`;
    dock.style.top = `${clamp(top * window.innerHeight - height / 2, 8, window.innerHeight - height - 8)}px`;
  }

  function persistDock() {
    dockWriteAt = Date.now();
    chrome.storage.local.set({ settings }).catch(() => {});
  }

  function bindDock() {
    const ball = dock.querySelector('.ot-ball');
    let dragging = false;
    let moved = false;
    let suppressClick = false;
    let startX = 0;
    let startY = 0;
    let grabX = 0;
    let grabY = 0;

    ball.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const rect = dock.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      grabX = event.clientX - rect.left;
      grabY = event.clientY - rect.top;
      dock.classList.add('is-dragging');
      dock.classList.remove('is-snapping');
      ball.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    ball.addEventListener('pointermove', event => {
      if (!dragging) return;
      if (!moved && Math.hypot(event.clientX - startX, event.clientY - startY) < 4) return;
      moved = true;
      const height = dockHeight();
      dock.style.left = `${clamp(event.clientX - grabX, 6, window.innerWidth - 50)}px`;
      dock.style.top = `${clamp(event.clientY - grabY, 6, window.innerHeight - height - 6)}px`;
    });

    const release = () => {
      if (!dragging) return;
      dragging = false;
      dock.classList.remove('is-dragging');
      if (!moved) return;
      const rect = dock.getBoundingClientRect();
      const height = rect.height;
      const side = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
      const top = clamp((rect.top + height / 2) / window.innerHeight, 0.08, 0.92);
      settings.ui.dock = { side, top };
      dock.dataset.side = side;
      dock.classList.add('is-snapping');
      dock.style.left = `${side === 'left' ? 10 : window.innerWidth - 54}px`;
      dock.style.top = `${clamp(top * window.innerHeight - height / 2, 8, window.innerHeight - height - 8)}px`;
      setTimeout(() => dock?.classList.remove('is-snapping'), 280);
      persistDock();
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

    dock.querySelector('.ot-gear').addEventListener('click', openOptions);
    window.addEventListener('resize', () => applyDockPosition());
  }

  function updateDock() {
    if (!dock) return;
    const ball = dock.querySelector('.ot-ball');
    const gear = dock.querySelector('.ot-gear');
    dock.classList.toggle('is-active', active);
    ball.textContent = active ? '还原' : '翻译';
    ball.setAttribute('aria-label', active ? '还原原文' : '翻译此页');
    ball.title = active ? '还原原文' : '翻译此页';
    gear.title = `设置 · 当前引擎：${ENGINE_SHORT[settings.engine] || settings.engine}`;
  }

  function renderDock() {
    if (!settings.ui.showFloatingButton) {
      dock?.remove();
      dock = null;
      return;
    }
    if (!dock || !dock.isConnected) {
      dock = document.createElement('div');
      dock.className = 'ot-dock';
      dock.innerHTML =
        '<button class="ot-gear" type="button" aria-label="设置">⚙</button>' +
        '<button class="ot-ball" type="button"></button>';
      document.body.append(dock);
      bindDock();
      applyDockPosition();
    }
    updateDock();
  }

  // ---------------------------------------------------------------- shortcuts

  function matchShortcut(event, combo) {
    if (!combo) return false;
    const parts = String(combo).toLowerCase().split('+').map(part => part.trim()).filter(Boolean);
    const key = parts.pop();
    const need = {
      alt: parts.includes('alt'),
      ctrl: parts.includes('ctrl'),
      shift: parts.includes('shift'),
      meta: parts.includes('meta') || parts.includes('cmd')
    };
    if (event.altKey !== need.alt || event.ctrlKey !== need.ctrl || event.shiftKey !== need.shift || event.metaKey !== need.meta) return false;
    return event.code?.toLowerCase() === `key${key}` || event.key?.toLowerCase() === key;
  }

  document.addEventListener('keydown', event => {
    if (matchShortcut(event, settings.shortcuts.toggle)) {
      event.preventDefault();
      toggle();
    } else if (matchShortcut(event, settings.shortcuts.selection)) {
      event.preventDefault();
      translateSelection();
    } else if (event.key === 'Escape') {
      closeBubble();
    }
  });

  // ---------------------------------------------------------------- bootstrap

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'toggle') toggle();
    else if (message?.type === 'restore') restore();
    else if (message?.type === 'translate-selection') translateSelection();
    else if (message?.type === 'translate') {
      if (message.target) settings.targetLanguage = message.target;
      if (active) restore();
      start();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    if (Date.now() - dockWriteAt < 600) return;
    const wasActive = active;
    loadSettings().then(() => {
      applyAppearance();
      renderDock();
      applyDockPosition();
      if (wasActive) {
        restore();
        start();
      }
    });
  });

  loadSettings().then(() => {
    applyAppearance();
    observe();
    if (document.body) renderDock();
    if (settings.autoTranslate || settings.siteRules.alwaysTranslate.some(matchesSite)) sleep(400).then(start);
  });
})();
