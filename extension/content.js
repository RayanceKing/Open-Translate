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
    subtitles: {
      enabled: true,
      mode: 'bilingual',
      fontSize: 100,
      position: 10,
      background: true,
      shortcut: 'Alt+S'
    },
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
        el.innerHTML = trustedHtml(html);
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

  async function translateSubtitleChunk(indices) {
    const { cues } = SUB_STATE;
    const texts = indices.map(index => cues[index].text);
    try {
      const results = await requestTranslation(texts);
      results.forEach((value, position) => {
        const index = indices[position];
        if (cues[index]) cues[index].translation = value || '';
      });
      if (indices.includes(SUB_STATE.index)) {
        const target = SUB_STATE.layer?.querySelector('.ot-sub-dst');
        if (target) target.textContent = cues[SUB_STATE.index]?.translation || '';
      }
    } catch (error) {
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
      indices.forEach(index => SUB_STATE.pending.delete(index));
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
    if (Date.now() - dockWriteAt < 600) return;
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
    if (document.body) renderDock();
    if (settings.autoTranslate || settings.siteRules.alwaysTranslate.some(matchesSite)) sleep(400).then(start);
  });
})();
