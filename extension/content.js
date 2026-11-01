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
    'reddit.com': [
      '[data-testid="post-content"]', '[id^="t3_"]', 'shreddit-post',
      'shreddit-comment', '[data-testid="comment"]'
    ],
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
      accent: '#007AFF',
      background: '#007AFF',
      radius: 6,
      paddingX: 8,
      paddingY: 2,
      marginTop: 4,
      marginBottom: 12
    },
    shortcuts: { toggle: 'Alt+T', selection: 'Alt+Shift+T' },
    subtitles: {
      enabled: true,
      mode: 'bilingual',
      fontSize: 100,
      position: 10,
      background: true,
      shortcut: 'Alt+S'
    },
    siteRules: { blacklist: [], alwaysTranslate: [] },
    ui: { showFloatingButton: true, dock: { side: 'right', top: 0.68 } },
    manga: {
      enabled: false,
      engine: 'gemini',
      style: { fontSize: 100, opacity: 100, backgroundOpacity: 75, color: '#ffffff', background: '#000000' }
    }
  };

  let settings = structuredClone(DEFAULTS);
  let active = false;
  let observer = null;
  let intersectionObserver = null;
  let lastIoAt = 0;
  let dock = null;
  let dockWriteAt = 0;
  let translating = new WeakSet();
  const pending = new Set();
  let flushScheduled = false;
  const queue = [];
  const originalHtml = new Map();
  let inflight = 0;

  // ---------------------------------------------------------------- utilities

  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  const translationText = text => String(text || '').replace(/\u00a0/g, ' ').trim();
  const TRANSLATION_TIMEOUT = 12000;

  function withTranslationTimeout(promise) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('翻译响应超时')), TRANSLATION_TIMEOUT))
    ]);
  }
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
    if (!match) return `rgba(0, 122, 255, ${alpha})`;
    const [r, g, b] = match.slice(1).map(part => parseInt(part, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const host = location.hostname.replace(/^www\./, '');
  const matchesSite = pattern => {
    const target = String(pattern).replace(/^\*\.?/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return Boolean(target) && (host === target || host.endsWith(`.${target}`));
  };

  // Sites that send `require-trusted-types-for 'script'` (YouTube among them)
  // reject any `element.innerHTML = "<markup>"`. Content scripts normally live
  // in an isolated world that is exempt, but routing markup through a policy
  // costs nothing and keeps us working if that changes.
  const trustedPolicy = (() => {
    try {
      return window.trustedTypes?.createPolicy?.('open-translate', { createHTML: markup => markup }) || null;
    } catch {
      return null; // the page may already own a policy with that name
    }
  })();

  const trustedHtml = markup => (trustedPolicy ? trustedPolicy.createHTML(markup) : markup);

  // ---------------------------------------------------------------- appearance

  const PRESETS = ['plain', 'underline', 'divider', 'card', 'quote', 'highlight', 'faded', 'blur'];
  const MODES = ['bilingual', 'translation', 'hover'];

  function applyAppearance() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.remove(...PRESETS.map(id => `ot-preset-${id}`), ...MODES.map(id => `ot-mode-${id}`), 'ot-loading-apple');
    root.classList.add(`ot-preset-${settings.style.preset}`, `ot-mode-${settings.displayMode}`);
    if (settings.style.loadingStyle === 'apple') root.classList.add('ot-loading-apple');

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

  // Safari's `chrome` shim does not return a promise from runtime.sendMessage
  // and requires a callback, so route every call through this helper and surface
  // chrome.runtime.lastError instead of swallowing it.
  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        if (typeof chrome?.runtime?.sendMessage !== 'function') {
          reject(new Error('chrome.runtime.sendMessage 不可用'));
          return;
        }
        chrome.runtime.sendMessage(message, response => {
          const lastError = chrome.runtime.lastError;
          if (lastError) reject(new Error(lastError.message || '消息发送失败'));
          else resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function requestTranslation(texts) {
    const response = await sendMessage({ type: 'translate', texts, target: settings.targetLanguage });
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

  const isBlockCandidate = el => {
    if (el.closest(SKIP)) return false;
    if (el.querySelector(`[${MARK}]`)) return false;
    if (el.nextElementSibling?.hasAttribute(MARK)) return false;
    if (el.querySelector('p,li,blockquote')) return false;
    if (!el.getClientRects().length && el.offsetParent === null) return false;
    return clean(el.innerText || el.textContent).length >= 2;
  };

  function collectBlocks(root) {
    // The observer hands us a single added node; querySelectorAll would miss it
    // when that node is itself a block (a lone <p>, <td>, <li>…).
    const self = root.nodeType === 1 && root.matches(BLOCK_SELECTOR) ? [root] : [];
    const semantic = [...self, ...root.querySelectorAll(BLOCK_SELECTOR)].filter(isBlockCandidate);

    // Div-soup regions used to be skipped wholesale as soon as the page had any
    // semantic block, which left entire panels untranslated — SPA "tables" made
    // of divs, card grids, sidebars built from <div><span>. Collect them per
    // region instead: an element qualifies only when it neither contains nor
    // sits inside a semantic block, and only when none of its own children
    // qualify (innermost wins, so a row and its cells never both translate).
    const soup = [...root.querySelectorAll('div,span')].filter(el => {
      if (el.children.length > 2) return false;
      if (el.closest(SKIP) || el.closest(BLOCK_SELECTOR)) return false;
      if (el.firstElementChild && el.querySelector(BLOCK_SELECTOR)) return false;
      // textContent, not innerText: this runs over every leaf div/span on the
      // page and innerText would force a layout for each one.
      return clean(el.textContent).length >= 20;
    });
    const soupSet = new Set(soup);
    return semantic.concat(soup.filter(el => !Array.from(el.children).some(child => soupSet.has(child))));
  }

  // ---------------------------------------------------------------- rendering

  // Inserting after an element whose parent is a flex/grid container turns the
  // translation into just another track of that container, so it gets squeezed
  // into a sliver — or a one-character-wide column. Append inside the block in
  // that case so it flows underneath instead.
  const stacksChildren = el => {
    if (!el) return false;
    const display = getComputedStyle(el).display;
    return display.includes('flex') || display.includes('grid');
  };

  function mountTranslation(el) {
    const node = document.createElement('div');
    node.className = 'ot-translation ot-pending';
    node.setAttribute(MARK, 'translation');
    const sourceStyle = getComputedStyle(el);
    for (const property of [
      'display', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
      'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent',
      'text-transform', 'white-space', 'word-break', 'overflow-wrap', 'direction',
      'writing-mode', 'vertical-align'
    ]) {
      node.style.setProperty(property, sourceStyle.getPropertyValue(property));
    }
    if (sourceStyle.display !== 'inline') {
      node.style.display = sourceStyle.display === 'inline-block' ? 'inline-block' : 'block';
    }
    node.style.margin = sourceStyle.margin;
    node.style.padding = sourceStyle.padding;
    const sourceLength = clean(el.textContent).length;
    if (settings.style.loadingStyle === 'apple') {
      node.classList.add('ot-loading-skeleton');
      node.style.setProperty('--ot-skeleton-width', `${Math.min(100, Math.max(12, sourceLength * 0.58))}%`);
    } else {
      node.textContent = '翻译中…';
    }

    if (settings.displayMode === 'translation') {
      originalHtml.set(el, el.innerHTML);
      el.innerHTML = '';
      el.append(node);
      el.classList.add('ot-swapped');
    } else if (INNER_HOSTS.includes(el.tagName) || stacksChildren(el.parentElement)) {
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
    node.classList.remove('ot-loading-skeleton');
    if (error) {
      node.textContent = `翻译失败：${error}`;
      node.classList.add('ot-error');
    } else {
      node.textContent = text;
      if (settings.style.loadingStyle === 'apple') node.classList.add('ot-result-reveal');
    }
  }

  function pump() {
    if (!active) return;
    while (inflight < settings.concurrency && queue.length) {
      const batch = queue.splice(0, Math.max(1, settings.batchSize));
      inflight += 1;
      withTranslationTimeout(requestTranslation(batch.map(item => item.text)))
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
    const text = translationText(el.innerText || el.textContent);
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
    if (!active) return 0;
    const targets = root === document ? contentRoots().flatMap(collectBlocks) : collectBlocks(root);
    const io = ensureIntersectionObserver();
    let added = 0;
    for (const el of targets) {
      if (translating.has(el) || pending.has(el)) continue;
      pending.add(el);
      if (io) io.observe(el);
      added += 1;
    }
    scheduleFlush();
    return added;
  }

  // Some SPAs render a panel while it is still display:none and reveal it later
  // by toggling a class. No node is added, so the MutationObserver never fires
  // and that content would stay untranslated for good. Re-scan a few times after
  // enabling, backing off each round; two rounds in a row with nothing new means
  // the page has settled and sweeping can stop.
  const SWEEP_DELAYS = [500, 1000, 1500, 3000];
  let sweepTimer = 0;
  let sweeps = 0;
  let idleSweeps = 0;

  function sweep() {
    sweepTimer = 0;
    if (!active || sweeps >= SWEEP_DELAYS.length) return;
    const added = scan(document);
    sweeps += 1;
    idleSweeps = added ? 0 : idleSweeps + 1;
    if (idleSweeps < 2) sweepTimer = setTimeout(sweep, SWEEP_DELAYS[sweeps] ?? 3000);
  }

  function startSweeping() {
    clearTimeout(sweepTimer);
    sweepTimer = 0;
    sweeps = 0;
    idleSweeps = 0;
    sweepTimer = setTimeout(sweep, SWEEP_DELAYS[0]);
  }

  // ---------------------------------------------------------------- lifecycle

  function restore() {
    active = false;
    queue.length = 0;
    pending.clear();
    clearTimeout(sweepTimer);
    sweepTimer = 0;
    sweeps = 0;
    idleSweeps = 0;
    intersectionObserver?.disconnect();
    lastIoAt = 0;
    for (const [el, html] of originalHtml) {
      if (el.isConnected) {
        el.innerHTML = trustedHtml(html);
        el.classList.remove('ot-swapped');
      }
    }
    originalHtml.clear();
    document.querySelectorAll(`[${MARK}]`).forEach(node => node.remove());
    translating = new WeakSet();
    restoreManga();
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
    // Translate the above-the-fold blocks right away instead of waiting for
    // the observer / next scroll tick.
    flushVisible();
    startSweeping();
    if (settings.manga?.enabled) startManga();
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
          scan(node);
          if (mangaActive) mangaScan(node);
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
    if (settings.style.loadingStyle === 'apple') {
      bubble.classList.add('ot-loading-apple', 'ot-loading-skeleton');
      bubble.style.setProperty('--ot-skeleton-width', `${Math.min(100, Math.max(24, text.length * 0.58))}%`);
    } else {
      bubble.textContent = '翻译中…';
    }
    bubble.style.top = `${Math.min(window.innerHeight - 90, rect.bottom) + window.scrollY + 8}px`;
    bubble.style.left = `${Math.max(8, Math.min(window.innerWidth - 340, rect.left)) + window.scrollX}px`;
    document.body.append(bubble);
    try {
      const [result] = await requestTranslation([text.slice(0, 4000)]);
      if (bubble) {
        bubble.textContent = result || '没有可显示的译文';
        bubble.classList.remove('ot-loading-apple', 'ot-loading-skeleton');
        if (settings.style.loadingStyle === 'apple') bubble.classList.add('ot-result-reveal');
      }
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

  // ---------------------------------------------------------------- subtitles
  //
  // Three sources feed the same cue list:
  //   textTracks  the browser already parsed the <track>, we just read cues
  //   vtt         fall back to fetching and parsing the .vtt ourselves
  //   youtube     captionTracks from the player response, fetched as json3
  // Rendering is our own overlay so the original and translated lines can be
  // styled together and kept in sync with playback.

  const SUB_ATTR = 'data-ot-sub';
  const SUB_PREFETCH = 12;

  const SUB_STATE = {
    on: false,
    userOff: false,
    video: null,
    layer: null,
    cues: [],
    index: -1,
    raf: 0,
    watchdog: 0,
    lastTick: 0,
    lastTime: -1,
    stalledAt: 0,
    ticks: 0,
    loading: false,
    pending: new Set(),
    handlers: null,
    cueHandler: null,
    mode: null,
    errorAt: 0
  };

  function isYouTube() {
    return /(^|\.)youtube\.com$/.test(host) || /(^|\.)youtube-nocookie\.com$/.test(host);
  }

  function videoArea(node) {
    const rect = node.getBoundingClientRect();
    return rect.width * rect.height;
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
    return pool.sort((a, b) => videoArea(b) - videoArea(a))[0];
  }

  function parseTimestamp(value) {
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
      const start = parseTimestamp(rawStart);
      const end = parseTimestamp(String(rawEnd || '').trim().split(/\s+/)[0]);
      if (start == null || end == null) continue;
      const body = lines
        .slice(timeIndex + 1)
        .join(' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
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
      tracks.find(item => item.kind === 'subtitles' && item.language?.startsWith(settings.targetLanguage.split('-')[0])) ||
      tracks.find(item => item.kind === 'subtitles') ||
      tracks.find(item => item.kind === 'captions') ||
      tracks[0];
    if (!track) return [];
    // 'hidden' loads the cue list without painting the browser's own captions.
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
      const response = await fetch(element.src);
      if (!response.ok) return [];
      return parseVtt(await response.text());
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
      /* player not ready yet */
    }
    if (!response) response = window.ytInitialPlayerResponse;
    const list = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(list) ? list : [];
  }

  function pickCaptionTrack(tracks) {
    const wanted = settings.sourceLanguage;
    const score = track => {
      let value = 0;
      if (track.kind !== 'asr') value += 4; // human-authored beats auto-generated
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
    const response = await fetch(url);
    if (!response.ok) throw new Error(`字幕轨请求失败（HTTP ${response.status}）`);
    return parseJson3(await response.json());
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
    layer.style.fontSize = `${clamp(rect.height * 0.085, 14, 40)}px`;
    layer.style.left = `${rect.left}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.top = `${Math.max(4, rect.top - 2)}px`;
    layer.style.transform = 'translateY(-100%)';
  }

  async function ytRenderText(text) {
    const generation = subtitleGeneration;
    const layer = ensureYtLayer();
    if (!text) { layer.classList.remove('is-visible'); layer.textContent = ''; return; }
    let translation = ytTransCache.get(text);
    if (translation === undefined) {
      try {
        translation = (await requestTranslation([text]))[0] || '';
      } catch {
        translation = '';
      }
      if (generation !== subtitleGeneration || text !== ytCurrentText()) return;
      ytTransCache.set(text, translation);
    }
    if (generation !== subtitleGeneration || text !== ytCurrentText()) return;
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
    SUB_STATE.cueHandler = { track: textTrack, url, onCue: null };
    return textTrack;
  }

  async function startCueDriver(video, cues) {
    cues.sort((a, b) => a.start - b.start);
    SUB_STATE.cues = cues;
    SUB_STATE.index = -1;
    SUB_STATE.video = video;
    const track = await injectHiddenTrack(video, cues);
    if (!track) return false;
    const onCue = () => {
      const active = track.activeCues;
      if (!active || !active.length) {
        SUB_STATE.index = -1;
        renderCue(-1);
        positionLayer();
        return;
      }
      let index = -1;
      for (const cue of active) {
        const hit = SUB_STATE.cues.findIndex(c => Math.abs(c.start - cue.startTime) < 0.05);
        if (hit >= 0) { index = hit; break; }
      }
      if (index < 0) return;
      SUB_STATE.index = index;
      renderCue(index);
      positionLayer();
    };
    track.addEventListener('cuechange', onCue);
    track.mode = 'hidden';
    SUB_STATE.cueHandler.onCue = onCue;
    onCue();
    return true;
  }

  // ------------------------------------------------------------ subtitle view

  function ensureLayer() {
    if (SUB_STATE.layer?.isConnected) return SUB_STATE.layer;
    const layer = document.createElement('div');
    layer.className = 'ot-sub';
    layer.setAttribute(SUB_ATTR, '');
    layer.innerHTML = trustedHtml('<div class="ot-sub-src"></div><div class="ot-sub-dst"></div>');
    document.body.append(layer);
    SUB_STATE.layer = layer;
    return layer;
  }

  function applySubtitleStyle() {
    const layer = SUB_STATE.layer;
    if (!layer) return;
    layer.classList.toggle('ot-sub-solid', Boolean(settings.subtitles.background));
    layer.classList.toggle('ot-sub-dst-only', settings.subtitles.mode === 'translation');
  }

  function positionLayer() {
    const { layer, video } = SUB_STATE;
    if (!layer || !video) return;
    const rect = video.getBoundingClientRect();
    const offscreen = rect.bottom < 40 || rect.top > window.innerHeight - 40 || rect.width < 120;
    layer.classList.toggle('is-offscreen', offscreen);
    if (offscreen) return;
    const gap = (rect.height * settings.subtitles.position) / 100;
    // Scale with the player so the overlay stays readable from a 360px embed
    // up to a full-screen 4K window.
    layer.style.fontSize = `${clamp(rect.height * 0.042, 14, 44) * (settings.subtitles.fontSize / 100)}px`;
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
    const layer = SUB_STATE.layer;
    if (!layer) return;
    const source = layer.querySelector('.ot-sub-src');
    const target = layer.querySelector('.ot-sub-dst');
    if (index < 0) {
      source.textContent = '';
      target.textContent = '';
      layer.classList.remove('is-visible');
      return;
    }
    const cue = SUB_STATE.cues[index];
    source.textContent = cue.text;
    target.textContent = cue.translation || '';
    layer.classList.add('is-visible');
    ensureTranslated(index);
  }

  function updateCue(force = false) {
    const { video, cues } = SUB_STATE;
    if (!video || !cues.length) return;
    const index = findCueIndex(cues, video.currentTime);
    // A seek can land on "no cue" (-1) right after another "no cue" frame, so
    // callers that jump in time pass force to re-render regardless.
    if (!force && index === SUB_STATE.index) return;
    SUB_STATE.index = index;
    try {
      renderCue(index);
    } catch {
      /* one malformed cue must not stall the rest of the track */
    }
  }

  // One synchronisation step. Cue switching and layout are isolated from each
  // other on purpose: a throw in either one used to take the other down with it.
  function syncOnce() {
    SUB_STATE.lastTick = Date.now();
    const video = ensureVideo();
    if (!video) return;
    try {
      updateCue();
    } catch {
      /* keep the driver alive */
    }
    try {
      positionLayer();
    } catch {
      /* keep the driver alive */
    }
  }

  function stopTick() {
    if (SUB_STATE.raf) cancelAnimationFrame(SUB_STATE.raf);
    SUB_STATE.raf = 0;
    if (SUB_STATE.watchdog) clearInterval(SUB_STATE.watchdog);
    SUB_STATE.watchdog = 0;
  }

  // Three drivers, because each one can stall on its own:
  //   rAF          smooth while the tab is visible and the page is idle
  //   timeupdate   still fires when rAF is paused (background tab, busy page)
  //   watchdog     catches the case where rAF silently stops but the tab looks
  //                visible, which is exactly the "only the first cue ever shows"
  //                report we had to chase down
  function startTick() {
    stopTick();
    const step = () => {
      SUB_STATE.raf = requestAnimationFrame(step);
      syncOnce();
    };
    SUB_STATE.raf = requestAnimationFrame(step);
    SUB_STATE.watchdog = setInterval(() => {
      if (Date.now() - SUB_STATE.lastTick < 150) return; // rAF is healthy
      syncOnce();
    }, 250);
  }

  // --------------------------------------------------------- subtitle loading

  async function ensureTranslated(index) {
    const { cues } = SUB_STATE;
    if (!cues.length) return;
    const from = Math.max(0, index - 2);
    const to = Math.min(cues.length - 1, index + SUB_PREFETCH);
    const missing = [];
    for (let cursor = from; cursor <= to; cursor += 1) {
      if (cues[cursor].translation === null && !SUB_STATE.pending.has(cursor)) missing.push(cursor);
    }
    if (!missing.length) return;
    missing.forEach(cursor => SUB_STATE.pending.add(cursor));
    await translateSubtitleChunk(missing);
  }

  let subtitleGeneration = 0;
  async function translateSubtitleChunk(indices) {
    const generation = subtitleGeneration;
    const { cues } = SUB_STATE;
    const texts = indices.map(index => cues[index].text);
    try {
      const results = await requestTranslation(texts);
      if (generation !== subtitleGeneration || cues !== SUB_STATE.cues) return;
      results.forEach((value, position) => {
        const index = indices[position];
        if (cues[index]) cues[index].translation = value || '';
      });
      if (indices.includes(SUB_STATE.index)) {
        const target = SUB_STATE.layer?.querySelector('.ot-sub-dst');
        if (target) target.textContent = cues[SUB_STATE.index]?.translation || '';
      }
    } catch (error) {
      if (generation !== subtitleGeneration || cues !== SUB_STATE.cues) return;
      // A failed batch must not tear down the overlay: the original line is
      // still readable and the next window shift retries. After a second
      // failure the cue is marked as "translated to nothing" so we stop
      // hammering the engine on every frame.
      indices.forEach(index => {
        const cue = cues[index];
        if (!cue) return;
        cue.attempts = (cue.attempts || 0) + 1;
        if (cue.attempts >= 2) cue.translation = '';
      });
      if (Date.now() - SUB_STATE.errorAt > 10000) {
        SUB_STATE.errorAt = Date.now();
        toast(`字幕翻译失败：${error.message}`);
      }
    } finally {
      if (generation === subtitleGeneration && cues === SUB_STATE.cues) indices.forEach(index => SUB_STATE.pending.delete(index));
    }
  }

  // YouTube rebuilds its player on navigation, so the element we bound to can
  // be detached while the page keeps playing. Re-bind instead of reading a
  // frozen currentTime forever.
  function ensureVideo() {
    const current = SUB_STATE.video;
    // Healthy: still attached and actually playing. Nothing to do.
    if (current?.isConnected && !current.paused && !current.ended) return current;
    // The bound element stopped playing (paused, ended, or YouTube rebuilt the
    // player). Look for a better one instead of reading a frozen currentTime.
    const next = findMainVideo();
    if (!next) return current && current.isConnected ? current : null;
    if (next === current) return current;
    unbindVideo();
    SUB_STATE.video = next;
    SUB_STATE.index = -1;
    bindVideo(next);
    return next;
  }

  function bindVideo(video) {
    if (SUB_STATE.handlers?.video === video) return;
    unbindVideo();
    const onPlay = () => startTick();
    const onPause = () => {
      stopTick();
      updateCue();
      positionLayer();
    };
    const onSeek = () => {
      updateCue(true);
      positionLayer();
    };
    video.addEventListener('play', onPlay);
    video.addEventListener('playing', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeek);
    video.addEventListener('emptied', onSeek);
    // `timeupdate` fires ~4x/s even when rAF is paused, so the cue still
    // advances in a background tab or on a page that starves animation frames.
    video.addEventListener('timeupdate', syncOnce);
    video.addEventListener('loadedmetadata', onSeek);
    SUB_STATE.handlers = { video, onPlay, onPause, onSeek };
  }

  function unbindVideo() {
    const handlers = SUB_STATE.handlers;
    if (!handlers) return;
    handlers.video.removeEventListener('play', handlers.onPlay);
    handlers.video.removeEventListener('playing', handlers.onPlay);
    handlers.video.removeEventListener('pause', handlers.onPause);
    handlers.video.removeEventListener('seeked', handlers.onSeek);
    handlers.video.removeEventListener('emptied', handlers.onSeek);
    handlers.video.removeEventListener('timeupdate', syncOnce);
    handlers.video.removeEventListener('loadedmetadata', handlers.onSeek);
    SUB_STATE.handlers = null;
  }

  function stopSubtitles() {
    stopYouTubeHook();
    if (SUB_STATE.cueHandler) {
      const { track, onCue, url } = SUB_STATE.cueHandler;
      if (track && onCue) track.removeEventListener('cuechange', onCue);
      if (url) URL.revokeObjectURL(url);
      SUB_STATE.cueHandler = null;
    }
    stopTick();
    unbindVideo();
    SUB_STATE.on = false;
    SUB_STATE.cues = [];
    SUB_STATE.index = -1;
    SUB_STATE.pending.clear();
    SUB_STATE.layer?.remove();
    SUB_STATE.layer = null;
    SUB_STATE.video = null;
    SUB_STATE.mode = null;
    document.documentElement.classList.remove('ot-sub-on', 'ot-sub-ythook');
  }

  async function startSubtitles(manual = false) {
    if (SUB_STATE.loading) return;
    // YouTube: prefer hooking the player's native caption window (immersive
    // style) -- the original stays native and we only add the translation.
    // Falls back to the injected-track path when captions cannot be turned on.
    if (isYouTube()) {
      if (startYouTubeHook()) {
        SUB_STATE.on = true;
        SUB_STATE.mode = 'ythook';
        document.documentElement.classList.add('ot-sub-on', 'ot-sub-ythook');
        return;
      }
      // hook failed; fall through to injected-track mode below
    }
    const video = SUB_STATE.video || findMainVideo();
    if (!video) {
      if (manual) toast('当前页面没有可用的视频');
      return;
    }
    SUB_STATE.video = video;
    SUB_STATE.on = true;
    SUB_STATE.mode = 'track';
    ensureLayer();
    applySubtitleStyle();
    positionLayer();
    document.documentElement.classList.add('ot-sub-on');

    SUB_STATE.loading = true;
    try {
      let cues = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          cues = await loadCues(video);
        } catch (error) {
          if (attempt === 2) throw error;
          cues = [];
        }
        if (cues.length || !SUB_STATE.on) break;
        // YouTube publishes captionTracks asynchronously, so the first attempt
        // can run before the player response exists. Retrying beats declaring
        // "no subtitles here" and never trying again for the rest of the video.
        if (!isYouTube()) break;
        await sleep(400 * (attempt + 1));
      }
      if (!SUB_STATE.on) return;
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
    } catch (error) {
      toast(`字幕加载失败：${error.message}`);
      stopSubtitles();
    } finally {
      SUB_STATE.loading = false;
    }
  }

  function toggleSubtitles() {
    if (SUB_STATE.on) {
      SUB_STATE.userOff = true;
      stopSubtitles();
      toast('已关闭双语字幕');
    } else {
      SUB_STATE.userOff = false;
      startSubtitles(true);
    }
  }

  // Auto-attach the first time a video actually starts playing, so decorative
  // muted videos on article pages never trigger a subtitle load.
  document.addEventListener(
    'play',
    event => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      if (!settings.subtitles.enabled || SUB_STATE.on || SUB_STATE.userOff) return;
      if (SUB_STATE.video && SUB_STATE.video !== event.target) return;
      startSubtitles();
    },
    true
  );

  window.addEventListener('resize', () => positionLayer());
  document.addEventListener('fullscreenchange', () => positionLayer());
  document.addEventListener('scroll', () => positionLayer(), { passive: true, capture: true });

  // YouTube is a SPA: the video element survives navigation, the captions do not.
  document.addEventListener('yt-navigate-finish', () => {
    if (!settings.subtitles.enabled || SUB_STATE.userOff) return;
    if (!SUB_STATE.on) return;
    stopSubtitles();
    startSubtitles();
  });

  // ---------------------------------------------------------------- manga / image translation
  //
  // Comic / manga panels are images, not text, so the normal text walker skips
  // them (img/svg/canvas are in SKIP). In manga mode we instead scan <img>
  // elements, OCR + translate each in one vision-API call (handled in the
  // background), then paint the translations back as a fixed-position overlay
  // aligned to the image and kept glued to it every animation frame.

  const MANGA_MIN_EDGE = 160;   // ignore icons / decorative images
  const MANGA_MAX_EDGE = 1600;  // downscale larger images before upload
  let mangaActive = false;
  let mangaRaf = 0;
  let mangaScanScheduled = false;
  const mangaOverlays = new Map();   // img -> { overlay, boxes }
  const mangaPending = new Set();    // imgs currently being processed
  let mangaProcessed = new WeakSet();

  function isMangaCandidate(img) {
    if (!img || img.tagName !== 'IMG') return false;
    if (img.classList.contains('ot-manga-done')) return false;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h || w < MANGA_MIN_EDGE || h < MANGA_MIN_EDGE) return false;
    return true;
  }

  function collectMangaImages(scope) {
    const root = scope === document ? document : (scope || document);
    return [...root.querySelectorAll('img')].filter(isMangaCandidate);
  }

  // Cross-origin images taint a canvas unless the host sends CORS headers. We
  // re-fetch with crossOrigin="anonymous" (served from the HTTP cache, so it is
  // fast); if the host does not allow it, toDataURL throws and the caller skips
  // that image instead of crashing the whole page.
  function imageToDataUrl(img) {
    return new Promise((resolve, reject) => {
      const src = img.currentSrc || img.src;
      if (!src) {
        reject(new Error('图片没有可用的地址'));
        return;
      }
      const loader = new Image();
      if (!src.startsWith('data:')) {
        loader.crossOrigin = 'anonymous';
        loader.referrerPolicy = 'no-referrer';
      }
      loader.onload = () => {
        try {
          resolve(downscaleImage(loader));
        } catch (error) {
          reject(error);
        }
      };
      loader.onerror = () => reject(new Error('图片加载失败（可能受跨域限制）'));
      loader.src = src;
    });
  }

  function downscaleImage(loader) {
    const naturalWidth = loader.naturalWidth || loader.width;
    const naturalHeight = loader.naturalHeight || loader.height;
    const scale = Math.min(1, MANGA_MAX_EDGE / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(loader, 0, 0, width, height);
    try {
      return canvas.toDataURL('image/png');
    } catch {
      throw new Error('无法读取图片像素（跨域限制），请尝试更换图源或关闭漫画模式');
    }
  }

  function createMangaOverlay(img) {
    const overlay = document.createElement('div');
    overlay.className = 'ot-manga';
    overlay.setAttribute('data-ot-manga-overlay', '');
    overlay.style.pointerEvents = 'none';
    overlay.style.position = 'fixed';
    const loading = document.createElement('div');
    loading.className = 'ot-manga-loading';
    loading.textContent = '识别中…';
    overlay.append(loading);
    document.body.append(overlay);
    return overlay;
  }

  function fillMangaOverlay(overlay, boxes) {
    const style = settings.manga.style;
    overlay.style.setProperty('--ot-manga-color', style.color);
    overlay.style.setProperty('--ot-manga-bg', style.background);
    overlay.style.setProperty('--ot-manga-bg-op', String(style.backgroundOpacity / 100));
    overlay.style.setProperty('--ot-manga-op', String(style.opacity / 100));
    overlay.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const item of boxes) {
      const [x, y, w, h] = item.box;
      const box = document.createElement('div');
      box.className = 'ot-manga-box';
      box.style.left = `${(x * 100).toFixed(3)}%`;
      box.style.top = `${(y * 100).toFixed(3)}%`;
      box.style.width = `${(w * 100).toFixed(3)}%`;
      box.style.height = `${(h * 100).toFixed(3)}%`;
      const span = document.createElement('span');
      span.className = 'ot-manga-text';
      span.textContent = item.translation;
      box.append(span);
      fragment.append(box);
    }
    overlay.append(fragment);
  }

  function positionManga() {
    const scale = (settings.manga.style.fontSize || 100) / 100;
    for (const [img, rec] of mangaOverlays) {
      if (!img.isConnected) {
        rec.overlay.remove();
        mangaOverlays.delete(img);
        continue;
      }
      const rect = img.getBoundingClientRect();
      const overlay = rec.overlay;
      if (rect.width < 1 || rect.height < 1 || rect.bottom < -300 || rect.top > window.innerHeight + 300) {
        overlay.style.visibility = 'hidden';
        continue;
      }
      overlay.style.visibility = 'visible';
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      for (const box of overlay.querySelectorAll('.ot-manga-box')) {
        const heightPercent = parseFloat(box.style.height) / 100;
        box.style.fontSize = `${Math.max(7, heightPercent * rect.height * scale)}px`;
      }
    }
  }

  function startMangaLoop() {
    if (mangaRaf) return;
    const step = () => {
      if (!mangaActive) {
        mangaRaf = 0;
        return;
      }
      positionManga();
      mangaRaf = requestAnimationFrame(step);
    };
    mangaRaf = requestAnimationFrame(step);
  }

  async function processMangaImage(img) {
    if (!img.isConnected || mangaProcessed.has(img) || img.classList.contains('ot-manga-done')) return;
    mangaProcessed.add(img);
    img.classList.add('ot-manga-done');
    const overlay = createMangaOverlay(img);
    try {
      const image = await imageToDataUrl(img);
      if (!mangaActive) {
        overlay.remove();
        return;
      }
      const result = await sendMessage({
        type: 'translate-image',
        image,
        source: settings.sourceLanguage || 'auto',
        target: settings.targetLanguage,
        engine: settings.manga.engine
      });
      if (!mangaActive) {
        overlay.remove();
        return;
      }
      if (!result || result.error) throw new Error(result?.error || '后台没有响应');
      const boxes = Array.isArray(result.boxes) ? result.boxes : [];
      if (!boxes.length) {
        overlay.remove();
        return;
      }
      fillMangaOverlay(overlay, boxes);
      mangaOverlays.set(img, { overlay, boxes });
      startMangaLoop();
    } catch (error) {
      overlay.remove();
      toast(`漫画翻译跳过一张图：${error?.message || '失败'}`);
    }
  }

  function mangaScan(scope = document) {
    if (!mangaActive) return;
    const images = collectMangaImages(scope);
    for (const img of images) {
      if (mangaProcessed.has(img) || mangaPending.has(img)) continue;
      if (!inViewport(img, 500)) continue; // only the panels near the viewport
      mangaPending.add(img);
      processMangaImage(img).finally(() => mangaPending.delete(img));
    }
  }

  function mangaOnScroll() {
    if (!mangaActive || mangaScanScheduled) return;
    mangaScanScheduled = true;
    setTimeout(() => {
      mangaScanScheduled = false;
      mangaScan(document);
    }, 120);
  }

  function startManga() {
    if (mangaActive) return;
    mangaActive = true;
    mangaScan(document);
    startMangaLoop();
    addEventListener('scroll', mangaOnScroll, { passive: true, capture: true });
    addEventListener('resize', mangaOnScroll, { passive: true });
  }

  function restoreManga() {
    mangaActive = false;
    if (mangaRaf) cancelAnimationFrame(mangaRaf);
    mangaRaf = 0;
    mangaScanScheduled = false;
    removeEventListener('scroll', mangaOnScroll, { capture: true });
    removeEventListener('resize', mangaOnScroll);
    for (const [, rec] of mangaOverlays) rec.overlay.remove();
    mangaOverlays.clear();
    mangaPending.clear();
    document.querySelectorAll('img.ot-manga-done').forEach(img => img.classList.remove('ot-manga-done'));
    mangaProcessed = new WeakSet();
  }

  // ---------------------------------------------------------------- floating dock

  function toast(message) {
    const node = document.createElement('div');
    node.className = 'ot-toast';
    node.textContent = message;
    document.body.append(node);
    setTimeout(() => node.remove(), 2600);
  }

  function openOptions() {
    // Open the options page directly from the content script. This is reliable
    // on both Chrome and Safari/iOS; the background `open-options` path is kept
    // only as a last-resort fallback (Safari's service worker cannot always
    // create a tab on its own).
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.create === 'function'
          && typeof chrome.runtime?.getURL === 'function') {
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
        return;
      }
    } catch (_) { /* fall through to the background fallback */ }
    sendMessage({ type: 'open-options' }).catch(() => {});
  }

  function dockPosition() {
    const stored = settings.ui.dock || {};
    return {
      side: stored.side === 'left' ? 'left' : 'right',
      top: typeof stored.top === 'number' ? stored.top : 0.68
    };
  }

  function dockHeight() {
    return dock ? dock.offsetHeight || 94 : 94;
  }

  function captchaRects() {
    const selectors = [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      'iframe[src*="challenges.cloudflare.com"]',
      '[class*="captcha" i]',
      '[id*="captcha" i]',
      '[data-sitekey]',
      '.cf-turnstile'
    ];
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)])
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0);
  }

  function dockPositionAvoidingCaptcha(side, top, height) {
    const width = dock.offsetWidth || 44;
    const maxTop = Math.max(8, window.innerHeight - height - 8);
    const candidates = [
      [side, top],
      [side, 0.12], [side, 0.5], [side, 0.88],
      [side === 'left' ? 'right' : 'left', top],
      [side === 'left' ? 'right' : 'left', 0.12],
      [side === 'left' ? 'right' : 'left', 0.5],
      [side === 'left' ? 'right' : 'left', 0.88]
    ];
    const rects = captchaRects();
    const score = ([candidateSide, candidateTop]) => {
      const left = candidateSide === 'left' ? 10 : window.innerWidth - 10 - width;
      const y = clamp(candidateTop * window.innerHeight - height / 2, 8, maxTop);
      const area = rects.reduce((total, rect) => {
        const overlapX = Math.max(0, Math.min(left + width, rect.right) - Math.max(left, rect.left));
        const overlapY = Math.max(0, Math.min(y + height, rect.bottom) - Math.max(y, rect.top));
        return total + overlapX * overlapY;
      }, 0);
      return area * 1000 + (candidateSide === side ? 0 : 1) + Math.abs(candidateTop - top);
    };
    return candidates.reduce((best, candidate) => score(candidate) < score(best) ? candidate : best);
  }

  function applyDockPosition() {
    if (!dock) return;
    const preferred = dockPosition();
    const height = dockHeight();
    const [side, top] = dockPositionAvoidingCaptcha(preferred.side, preferred.top, height);
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
      dock.classList.add('is-snapping');
      applyDockPosition();
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
      dock.innerHTML = trustedHtml(
        '<button class="ot-gear" type="button" aria-label="设置">⚙</button>' +
          '<button class="ot-ball" type="button"></button>'
      );
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
    } else if (matchShortcut(event, settings.subtitles.shortcut)) {
      event.preventDefault();
      toggleSubtitles();
    } else if (event.key === 'Escape') {
      closeBubble();
    }
  });

  let touchGesture = null;
  document.addEventListener('touchstart', event => {
    const count = event.touches.length;
    if ((count === 3 || count === 4) && settings.shortcuts.toggle === `Touch${count}`) {
      touchGesture = { count, x: event.touches[0].clientX, y: event.touches[0].clientY };
    } else {
      touchGesture = null;
    }
  }, { passive: true });
  document.addEventListener('touchend', event => {
    if (!touchGesture || event.touches.length !== 0) return;
    const gesture = touchGesture;
    touchGesture = null;
    if (settings.shortcuts.toggle !== `Touch${gesture.count}`) return;
    event.preventDefault();
    toggle();
  }, { passive: false });
  document.addEventListener('touchcancel', () => {
    touchGesture = null;
  }, { passive: true });

  // ---------------------------------------------------------------- bootstrap

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'toggle') toggle();
    else if (message?.type === 'restore') restore();
    else if (message?.type === 'translate-selection') translateSelection();
    else if (message?.type === 'toggle-subtitles') toggleSubtitles();
    else if (message?.type === 'translate') {
      if (message.target) settings.targetLanguage = message.target;
      if (active) restore();
      start();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const relevant = value => JSON.stringify([value?.glossary, value?.ai, value?.engine, value?.engines, value?.sourceLanguage, value?.targetLanguage, value?.privacy]);
    const translationChanged = relevant(changes.settings.oldValue) !== relevant(changes.settings.newValue);
    if (!translationChanged && Date.now() - dockWriteAt < 600) return;
    if (translationChanged) {
      subtitleGeneration += 1;
      ytTransCache.clear();
      ytLastText = '';
      SUB_STATE.pending.clear();
      SUB_STATE.cues.forEach(cue => { cue.translation = null; cue.attempts = 0; });
      SUB_STATE.index = -1;
      const target = SUB_STATE.layer?.querySelector('.ot-sub-dst');
      if (target) target.textContent = '';
    }
    const wasActive = active;
    loadSettings().then(() => {
      applyAppearance();
      applySubtitleStyle();
      renderDock();
      applyDockPosition();
      if (wasActive) {
        restore();
        start();
      }
      if (!settings.subtitles.enabled) stopSubtitles();
      else if (SUB_STATE.on) positionLayer();
    });
  });

  loadSettings().then(() => {
    applyAppearance();
    observe();
    watchViewport();
    if (document.body) renderDock();
    if (settings.autoTranslate || settings.siteRules.alwaysTranslate.some(matchesSite)) sleep(400).then(start);
  });
})();
