import { normalizeGlossarySettings } from './glossary.js';

// Shared settings model. Imported by the service worker, options page and popup.

export const APP_VERSION = '1.0.0';

export const deviceLanguage = () => {
  const language = String(globalThis.navigator?.language || '').toLowerCase();
  if (language.startsWith('zh-tw') || language.startsWith('zh-hk')) return 'zh-TW';
  if (language.startsWith('zh')) return 'zh-CN';
  if (language.startsWith('ja')) return 'ja';
  if (language.startsWith('ko')) return 'ko';
  if (language.startsWith('fr')) return 'fr';
  if (language.startsWith('de')) return 'de';
  if (language.startsWith('es')) return 'es';
  return 'en';
};

export const interfaceLanguage = () => deviceLanguage() === 'en' ? 'en' : 'zh-CN';

/** Accent shipped before the switch to Apple system blue. See normalizeSettings. */
const LEGACY_ACCENT = '#6d5dfc';

export const LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English · 英语' },
  { code: 'ja', label: '日本語 · 日语' },
  { code: 'ko', label: '한국어 · 韩语' },
  { code: 'fr', label: 'Français · 法语' },
  { code: 'de', label: 'Deutsch · 德语' },
  { code: 'es', label: 'Español · 西班牙语' },
  { code: 'ru', label: 'Русский · 俄语' },
  { code: 'pt', label: 'Português · 葡萄牙语' },
  { code: 'it', label: 'Italiano · 意大利语' },
  { code: 'nl', label: 'Nederlands · 荷兰语' },
  { code: 'pl', label: 'Polski · 波兰语' },
  { code: 'tr', label: 'Türkçe · 土耳其语' },
  { code: 'ar', label: 'العربية · 阿拉伯语' },
  { code: 'hi', label: 'हिन्दी · 印地语' },
  { code: 'th', label: 'ไทย · 泰语' },
  { code: 'vi', label: 'Tiếng Việt · 越南语' },
  { code: 'id', label: 'Bahasa Indonesia · 印尼语' },
  { code: 'uk', label: 'Українська · 乌克兰语' }
];

export const LANG_LABEL = Object.fromEntries(LANGUAGES.map(item => [item.code, item.label]));

export const DISPLAY_MODES = [
  { id: 'bilingual', name: '双语对照', desc: '原文在上，译文紧随其后，最常用的阅读方式' },
  { id: 'translation', name: '仅译文', desc: '隐藏原文，只显示译文，适合快速浏览' },
  { id: 'hover', name: '悬停显示', desc: '译文默认隐藏，鼠标移到原文上才浮现' }
];

export const SUBTITLE_MODES = [
  { id: 'bilingual', name: '双语字幕', desc: '原文在上、译文在下，对照着看' },
  { id: 'translation', name: '仅译文', desc: '只显示译文，画面更干净' }
];

export const STYLE_PRESETS = [
  { id: 'plain', name: '无样式', desc: '只插入译文，不加任何装饰' },
  { id: 'underline', name: '虚线下划线', desc: '译文下方一条虚线，最接近沉浸式默认' },
  { id: 'divider', name: '左侧竖线', desc: '左侧细线分隔，长文阅读不累眼' },
  { id: 'card', name: '卡片', desc: '浅色背景加圆角，层次分明' },
  { id: 'quote', name: '引用块', desc: '左侧粗线加缩进，像引文一样' },
  { id: 'highlight', name: '高亮', desc: '背景高亮，扫读时更容易抓住重点' },
  { id: 'faded', name: '淡色文字', desc: '降低对比度，让原文保持主导' },
  { id: 'blur', name: '模糊', desc: '译文默认模糊，鼠标悬停才清晰' }
];

export const DEFAULT_PROMPT = [
  'You are a professional translator. Translate the text into {{target}}.',
  'Rules:',
  '1. Output only the translation. No explanations, no notes, no surrounding quotes.',
  '2. Preserve the original paragraph breaks, markdown, links, numbers, code and proper nouns.',
  '3. Keep the tone natural and idiomatic for native readers.'
].join('\n');

export const DEFAULT_SETTINGS = {
  version: APP_VERSION,
  engine: 'google',
  sourceLanguage: 'auto',
  targetLanguage: deviceLanguage(),
  interfaceLanguage: interfaceLanguage(),
  displayMode: 'bilingual',
  autoTranslate: false,
  batchSize: 4,
  concurrency: 2,
  privacy: {
    maskSensitive: true
  },
  style: {
    preset: 'underline',
    loadingStyle: 'standard',
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
  engines: {
    google: {},
    mymemory: {},
    deepl: { key: '', pro: false },
    microsoft: { useKey: false, key: '', region: 'global' },
    libre: { url: '', key: '' },
    apple: {},
    openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
    gemini: { apiKey: '', model: 'gemini-2.0-flash' },
    claude: { apiKey: '', model: 'claude-3-5-haiku-latest' },
    custom: { name: '', baseUrl: '', apiKey: '', model: '' }
  },
  ai: {
    prompt: DEFAULT_PROMPT,
    glossary: '',
    temperature: 0.2
  },
  glossary: { enabled: true, machineTranslation: false, libraryIds: [], customTerms: '', customTargetLanguage: '*' },
  subtitles: {
    enabled: true,
    mode: 'bilingual',
    fontSize: 100,
    position: 10,
    background: true,
    shortcut: 'Alt+S'
  },
  shortcuts: {
    toggle: 'Alt+T',
    selection: 'Alt+Shift+T'
  },
  siteRules: {
    blacklist: [],
    alwaysTranslate: []
  },
  ui: {
    showFloatingButton: true,
    theme: 'auto',
    dock: { side: 'right', top: 0.68 }
  },
  manga: {
    enabled: false,
    engine: 'gemini',
    style: {
      fontSize: 100,
      opacity: 100,
      backgroundOpacity: 75,
      color: '#ffffff',
      background: '#000000'
    }
  }
};

export const AI_ENGINES = ['openai', 'deepseek', 'gemini', 'claude', 'custom'];

/** Engines that can read an image and return both OCR + translation in one call. */
export const VISION_ENGINES = ['openai', 'gemini', 'claude'];

// Which field of each engine's config holds the secret API key. These values are
// stored in the system Keychain (see lib/store.js + the native Swift handler)
// and must NEVER be written to local storage or iCloud sync.
export const SECRET_FIELDS = {
  openai: 'apiKey',
  deepseek: 'apiKey',
  gemini: 'apiKey',
  claude: 'apiKey',
  custom: 'apiKey',
  libre: 'apiKey',
  deepl: 'key',
  microsoft: 'key'
};

// Return a shallow-cloned copy of settings with every secret field blanked, so
// the result is safe to persist locally or mirror to iCloud.
export function stripSecrets(settings) {
  const out = structuredClone(settings);
  for (const [engine, field] of Object.entries(SECRET_FIELDS)) {
    if (out.engines && out.engines[engine]) out.engines[engine][field] = '';
  }
  return out;
}

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

export function mergeSettings(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(base);
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(output[key])) output[key] = mergeSettings(output[key], value);
    else if (value !== undefined) output[key] = value;
  }
  return output;
}

/** Fill in anything missing from a stored (possibly older) settings object. */
export function normalizeSettings(raw) {
  // Before 0.2.0 Microsoft only had a keyed Azure channel, so a stored key with
  // no `useKey` flag means the user was on Azure — keep them there instead of
  // silently switching them to the free channel.
  const legacyMicrosoftKey =
    isPlainObject(raw?.engines?.microsoft) &&
    raw.engines.microsoft.useKey === undefined &&
    String(raw.engines.microsoft.key || '').trim() !== '';

  const settings = mergeSettings(DEFAULT_SETTINGS, raw || {});
  settings.version = APP_VERSION;
  if (!['Touch3', 'Touch4'].includes(settings.shortcuts.toggle) && !String(settings.shortcuts.toggle || '').trim()) {
    settings.shortcuts.toggle = DEFAULT_SETTINGS.shortcuts.toggle;
  }
  if (!['auto', 'light', 'dark'].includes(settings.ui.theme)) settings.ui.theme = 'auto';
  settings.glossary = normalizeGlossarySettings(raw?.glossary, raw?.ai?.glossary || '', settings.targetLanguage);
  if (legacyMicrosoftKey) settings.engines.microsoft.useKey = true;
  // The shipped accent used to be purple; anyone who never opened the colour
  // pickers still carries that value, so remap the old default to Apple blue.
  for (const key of ['accent', 'background']) {
    if (String(settings.style[key]).toLowerCase() === LEGACY_ACCENT) {
      settings.style[key] = DEFAULT_SETTINGS.style[key];
    }
  }
  if (!DISPLAY_MODES.some(mode => mode.id === settings.displayMode)) settings.displayMode = 'bilingual';
  if (!STYLE_PRESETS.some(preset => preset.id === settings.style.preset)) settings.style.preset = 'underline';
  if (!['standard', 'apple'].includes(settings.style.loadingStyle)) settings.style.loadingStyle = 'standard';
  settings.batchSize = clamp(Number(settings.batchSize) || 4, 1, 10);
  settings.concurrency = clamp(Number(settings.concurrency) || 2, 1, 5);
  settings.style.fontSize = clamp(Number(settings.style.fontSize) || 100, 60, 200);
  settings.style.opacity = clamp(Number(settings.style.opacity) || 100, 20, 100);
  settings.style.lineHeight = clamp(Number(settings.style.lineHeight) || 1.7, 1, 2.6);
  if (!['bilingual', 'translation'].includes(settings.subtitles.mode)) settings.subtitles.mode = 'bilingual';
  settings.subtitles.fontSize = clamp(Number(settings.subtitles.fontSize) || 100, 60, 200);
  settings.subtitles.position = clamp(Number(settings.subtitles.position) || 10, 2, 45);
  settings.subtitles.enabled = Boolean(settings.subtitles.enabled);
  settings.subtitles.background = Boolean(settings.subtitles.background);
  settings.siteRules.blacklist = toList(settings.siteRules.blacklist);
  settings.siteRules.alwaysTranslate = toList(settings.siteRules.alwaysTranslate);

  const rawManga = isPlainObject(raw?.manga) ? raw.manga : {};
  const rawMangaStyle = isPlainObject(rawManga.style) ? rawManga.style : {};
  settings.manga = {
    enabled: Boolean(rawManga.enabled),
    engine: VISION_ENGINES.includes(rawManga.engine) ? rawManga.engine : 'gemini',
    style: {
      fontSize: clamp(Number(rawMangaStyle.fontSize) || 100, 40, 200),
      opacity: clamp(Number(rawMangaStyle.opacity) || 100, 20, 100),
      backgroundOpacity: clamp(Number(rawMangaStyle.backgroundOpacity ?? 75) || 75, 0, 100),
      color: typeof rawMangaStyle.color === 'string' && rawMangaStyle.color ? rawMangaStyle.color : '#ffffff',
      background: typeof rawMangaStyle.background === 'string' && rawMangaStyle.background ? rawMangaStyle.background : '#000000'
    }
  };
  return settings;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toList(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  return [...new Set(source.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
}

/** Style object -> CSS custom properties applied on <html>. */
export function styleToVars(style) {
  const background = style.background || '#007AFF';
  return {
    '--ot-fs': String(style.fontSize / 100),
    '--ot-lh': String(style.lineHeight),
    '--ot-fw': String(style.fontWeight),
    '--ot-op': String(style.opacity / 100),
    '--ot-color': style.colorMode === 'custom' ? style.color : 'inherit',
    '--ot-accent': style.accent,
    '--ot-accent-soft': hexToRgba(background, 0.1),
    '--ot-accent-line': hexToRgba(background, 0.32),
    '--ot-bg': hexToRgba(background, 0.1),
    '--ot-radius': `${style.radius}px`,
    '--ot-px': `${style.paddingX}px`,
    '--ot-py': `${style.paddingY}px`,
    '--ot-mt': `${style.marginTop}px`,
    '--ot-mb': `${style.marginBottom}px`
  };
}

export function hexToRgba(hex, alpha) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
  if (!match) return `rgba(0, 122, 255, ${alpha})`;
  const [r, g, b] = match.slice(1).map(part => parseInt(part, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
