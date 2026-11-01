import {
  APP_VERSION,
  AI_ENGINES,
  DEFAULT_PROMPT,
  DEFAULT_SETTINGS,
  DISPLAY_MODES,
  LANGUAGES,
  SECRET_FIELDS,
  STYLE_PRESETS,
  SUBTITLE_MODES,
  VISION_ENGINES,
  normalizeSettings,
  styleToVars
} from './lib/defaults.js';
import { ENGINE_CATALOG, ENGINE_BY_ID } from './lib/catalog.js';
import { loadSettings, saveSettings, getAllSecrets, setSecret } from './lib/store.js';
import { GLOSSARY_SOURCE, GLOSSARY_LIBRARIES } from './lib/glossary-data.js';
import { parseCustomTerms, serializeGlossaryCsv } from './lib/glossary.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const IS_SAFARI = typeof chrome !== 'undefined' && !!chrome.runtime &&
  (chrome.runtime.getURL?.('') || '').startsWith('safari-web-extension:');
const VISIBLE_ENGINES = ENGINE_CATALOG.filter(engine => engine.id !== 'apple' || IS_SAFARI);

const getPath = (object, path) => path.split('.').reduce((value, key) => (value == null ? value : value[key]), object);
const setPath = (object, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((node, key) => (node[key] ??= {}), object);
  target[last] = value;
};

// Safari's `chrome` shim does NOT return a promise from runtime.sendMessage and
// requires a callback, so route every call through this helper. It also reports
// `chrome.runtime.lastError` instead of swallowing it.
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

let settings = normalizeSettings(null);
let secretStatus = {};
let saveTimer = null;
let toastTimer = null;

// ---------------------------------------------------------------- save plumbing

function showHint(text = '已保存') {
  const hint = $('#save-hint');
  hint.textContent = text;
  hint.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hint.classList.remove('is-visible'), 1400);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  settings = await saveSettings(settings);
  showHint();
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  setTimeout(() => {
    node.hidden = true;
  }, 2200);
}

// ---------------------------------------------------------------- glossary

function renderGlossaries() {
  const list = $('#glossary-libraries');
  list.replaceChildren();
  const query = $('#glossary-search').value.trim().toLowerCase();
  const languageName = code => ['*', 'auto'].includes(code) ? '所有语言' : (LANGUAGES.find(item => item.code === code)?.label || code);
  $('#glossary-summary').textContent = `已选 ${settings.glossary.libraryIds.length} / ${GLOSSARY_LIBRARIES.length}`;
  for (const library of GLOSSARY_LIBRARIES) {
    if (![library.name, library.description, library.id].some(value => String(value || '').toLowerCase().includes(query))) continue;
    const label = document.createElement('label');
    label.className = 'glossary-library';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.library = library.id;
    input.checked = settings.glossary.libraryIds.includes(library.id);
    input.addEventListener('change', () => {
      settings.glossary.libraryIds = settings.glossary.libraryIds.filter(id => id !== library.id);
      if (input.checked) settings.glossary.libraryIds.push(library.id);
      $('#glossary-summary').textContent = `已选 ${settings.glossary.libraryIds.length} / ${GLOSSARY_LIBRARIES.length}`;
      scheduleSave();
    });
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = library.name;
    const description = document.createElement('small');
    description.textContent = library.description;
    const languages = document.createElement('small');
    languages.textContent = `${library.langs.map(languageName).join(' / ')} · ${library.entries.length} 条`;
    text.append(title, description, languages);
    label.append(input, text);
    list.append(label);
  }
  $('#glossary-empty').hidden = list.childElementCount !== 0;
}

function bindGlossary() {
  const language = $('#glossary-language');
  const universal = document.createElement('option');
  universal.value = '*'; universal.textContent = '所有目标语言';
  language.append(universal);
  for (const item of LANGUAGES) {
    const option = document.createElement('option');
    option.value = item.code; option.textContent = item.label; language.append(option);
  }
  const source = $('#glossary-source');
  const link = document.createElement('a');
  link.href = GLOSSARY_SOURCE.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.textContent = `Open-Translate-Terms · ${GLOSSARY_SOURCE.revision.slice(0, 8)} · ${GLOSSARY_SOURCE.license}`;
  source.append(link);
  $('#glossary-search').addEventListener('input', renderGlossaries);
  const custom = $('#glossary-custom');
  function updateCustom() {
    try {
      parseCustomTerms(custom.value, settings.glossary.customTargetLanguage);
      settings.glossary.customTerms = custom.value;
      $('#glossary-error').textContent = '';
      scheduleSave();
    } catch (error) { $('#glossary-error').textContent = error.message; }
  }
  custom.addEventListener('input', updateCustom);
  $('#glossary-import').addEventListener('click', () => $('#glossary-file').click());
  $('#glossary-file').addEventListener('change', async event => {
    try {
      const file = event.target.files?.[0];
      if (!file) return;
      const entries = parseCustomTerms(await file.text(), settings.glossary.customTargetLanguage);
      custom.value = serializeGlossaryCsv(entries);
      updateCustom();
    } catch (error) { $('#glossary-error').textContent = error.message; }
    finally { event.target.value = ''; }
  });
  $('#glossary-export').addEventListener('click', () => {
    try {
      const entries = parseCustomTerms(custom.value, settings.glossary.customTargetLanguage);
      const url = URL.createObjectURL(new Blob([serializeGlossaryCsv(entries)], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'open-translate-terms.csv'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { $('#glossary-error').textContent = error.message; }
  });
}

// ---------------------------------------------------------------- static UI

function renderEngineSelect() {
  const select = $('#engine');
  select.innerHTML = VISIBLE_ENGINES.map(engine => {
    const suffix = engine.tag === 'AI' ? ' · AI' : engine.tag === '免费' ? '' : ` · ${engine.tag}`;
    return `<option value="${engine.id}">${engine.name}${suffix}</option>`;
  }).join('');
}

function renderMangaEngineSelect() {
  const select = $('#manga-engine');
  if (!select) return;
  select.innerHTML = VISION_ENGINES
    .map(id => `<option value="${id}">${ENGINE_BY_ID[id]?.name || id}</option>`)
    .join('');
}

function renderLanguages() {
  const options = LANGUAGES.map(item => `<option value="${item.code}">${item.label}</option>`).join('');
  $('#targetLanguage').innerHTML = options;
  $('#sourceLanguage').innerHTML = `<option value="auto">自动检测</option>${options}`;
}

function renderDisplayModes() {
  const container = $('#display-modes');
  container.innerHTML = DISPLAY_MODES.map(
    mode => `<button type="button" class="radio-card" data-mode="${mode.id}">
      <strong>${mode.name}</strong><span>${mode.desc}</span>
    </button>`
  ).join('');
  container.addEventListener('click', event => {
    const card = event.target.closest('[data-mode]');
    if (!card) return;
    settings.displayMode = card.dataset.mode;
    syncDisplayModes();
    scheduleSave();
  });
}

function syncDisplayModes() {
  $$('#display-modes .radio-card').forEach(card => card.classList.toggle('is-selected', card.dataset.mode === settings.displayMode));
}

function renderSubtitleModes() {
  const container = $('#subtitle-modes');
  container.innerHTML = SUBTITLE_MODES.map(
    mode => `<button type="button" class="radio-card" data-subtitle-mode="${mode.id}">
      <strong>${mode.name}</strong><span>${mode.desc}</span>
    </button>`
  ).join('');
  container.addEventListener('click', event => {
    const card = event.target.closest('[data-subtitle-mode]');
    if (!card) return;
    settings.subtitles.mode = card.dataset.subtitleMode;
    syncSubtitleModes();
    scheduleSave();
  });
}

function syncSubtitleModes() {
  $$('#subtitle-modes .radio-card').forEach(card =>
    card.classList.toggle('is-selected', card.dataset.subtitleMode === settings.subtitles.mode)
  );
}

function renderPresets() {
  const container = $('#presets');
  container.innerHTML = STYLE_PRESETS.map(
    preset => `<button type="button" class="preset" data-preset="${preset.id}">
      <div class="preset-demo"><div class="line-original"></div><div class="line-translation"></div></div>
      <div class="preset-name">${preset.name}</div>
      <div class="preset-desc">${preset.desc}</div>
    </button>`
  ).join('');
  container.addEventListener('click', event => {
    const card = event.target.closest('[data-preset]');
    if (!card) return;
    settings.style.preset = card.dataset.preset;
    syncPresets();
    renderPreview();
    scheduleSave();
  });
}

function syncPresets() {
  $$('#presets .preset').forEach(card => card.classList.toggle('is-selected', card.dataset.preset === settings.style.preset));
}

function renderPreview() {
  const preview = $('#preview');
  preview.className = `preview preset-${settings.style.preset}`;
  for (const [key, value] of Object.entries(styleToVars(settings.style))) preview.style.setProperty(key, value);
}

// ---------------------------------------------------------------- services

function renderServices() {
  const container = $('#services-list');
  container.innerHTML = VISIBLE_ENGINES.map(engine => {
    const config = settings.engines[engine.id] || {};
    const serviceName = engine.id === 'custom' && config.name?.trim() ? config.name.trim() : engine.name;
    const fields = (Array.isArray(engine.fields) ? engine.fields : [])
      .map(field => {
        const depends = field.dependsOn ? ` data-depends="${field.dependsOn}"` : '';
        const hidden = field.dependsOn && !config[field.dependsOn] ? ' hidden' : '';
        if (field.type === 'switch') {
          return `<div class="service-field"${depends}${hidden}>
            <label for="eng-${engine.id}-${field.key}">${field.label}</label>
            <label class="switch">
              <input type="checkbox" id="eng-${engine.id}-${field.key}" data-engine="${engine.id}" data-key="${field.key}" data-kind="switch" ${config[field.key] ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
            <span class="service-status">${field.hint || ''}</span>
          </div>`;
        }
        if (field.type === 'password') {
          const has = Boolean(secretStatus[engine.id]);
          const status = has
            ? '<span class="secret-status is-set">已保存（仅本机钥匙串）</span>'
            : '<span class="secret-status">未保存</span>';
          return `<div class="service-field"${depends}${hidden}>
            <label for="eng-${engine.id}-${field.key}">${field.label}</label>
            <input type="password" id="eng-${engine.id}-${field.key}" data-engine="${engine.id}" data-key="${field.key}" value="" placeholder="${field.placeholder || ''}" spellcheck="false" autocomplete="off">
            ${status}
          </div>`;
        }
        const value = String(config[field.key] ?? '').replace(/"/g, '&quot;');
        return `<div class="service-field"${depends}${hidden}>
          <label for="eng-${engine.id}-${field.key}">${field.label}</label>
          <input type="text" id="eng-${engine.id}-${field.key}" data-engine="${engine.id}" data-key="${field.key}" value="${value}" placeholder="${field.placeholder || ''}" spellcheck="false" autocomplete="off">
        </div>`;
      })
      .join('');

    return `<div class="service ${settings.engine === engine.id ? 'is-active' : ''}" data-service="${engine.id}">
      <div class="service-head">
        <span class="service-name">${serviceName}</span>
        <span class="tag ${engine.tag === 'AI' ? 'is-ai' : ''}">${engine.tag}</span>
        <span style="flex:1"></span>
        <button type="button" class="ghost" data-use="${engine.id}">${settings.engine === engine.id ? '使用中' : '使用'}</button>
      </div>
      <p class="service-note">${engine.note}</p>
      <div class="service-body">${fields}</div>
      <div class="service-foot">
        <button type="button" class="ghost small" data-test="${engine.id}">测试连接</button>
        <span class="service-status" data-status="${engine.id}"></span>
      </div>
    </div>`;
  }).join('');
}

function bindServices() {
  const container = $('#services-list');

  container.addEventListener('click', async event => {
    const useButton = event.target.closest('[data-use]');
    if (useButton) {
      settings.engine = useButton.dataset.use;
      $('#engine').value = settings.engine;
      updateEngineNote();
      syncServiceActive();
      await flushSave();
      return;
    }
    const testButton = event.target.closest('[data-test]');
    if (testButton) await testEngine(testButton.dataset.test, testButton);
  });

  container.addEventListener('change', event => {
    const input = event.target.closest('[data-engine]');
    if (!input) return;
    const { engine, key, kind } = input.dataset;
    if (SECRET_FIELDS[engine] === key) {
      // Secret keys go to the system Keychain, never into settings / iCloud.
      const value = input.value;
      setSecret(engine, value)
        .then(() => {
          secretStatus[engine] = value.trim() ? value.trim() : undefined;
          const badge = input.parentElement.querySelector('.secret-status');
          if (badge) {
            const set = Boolean(value.trim());
            badge.textContent = set ? '已保存（仅本机钥匙串）' : '未保存';
            badge.classList.toggle('is-set', set);
          }
        })
        .catch(() => toast('密钥保存失败，请重试'));
      return;
    }
    settings.engines[engine] ??= {};
    settings.engines[engine][key] = kind === 'switch' ? input.checked : input.value.trim();
    if (kind === 'switch') syncServiceDeps(input.closest('[data-service]'));
    scheduleSave();
  });

  container.addEventListener('input', event => {
    const input = event.target.closest('[data-engine]');
    if (!input || input.dataset.kind === 'switch') return;
    // Secrets are persisted on the change event (so we don't hit the Keychain
    // on every keystroke); ignore them here.
    if (SECRET_FIELDS[input.dataset.engine] === input.dataset.key) return;
    const { engine, key } = input.dataset;
    settings.engines[engine] ??= {};
    settings.engines[engine][key] = input.value.trim();
    scheduleSave();
  });
}

function syncServiceDeps(card) {
  if (!card) return;
  card.querySelectorAll('[data-depends]').forEach(field => {
    const toggle = card.querySelector(`[data-engine][data-key="${field.dataset.depends}"]`);
    field.hidden = !(toggle && toggle.checked);
  });
}

function syncServiceActive() {
  $$('[data-service]').forEach(card => card.classList.toggle('is-active', card.dataset.service === settings.engine));
}

function showSelectedService() {
  if (!AI_ENGINES.includes(settings.engine)) return;
  const section = $('#services');
  const card = $(`[data-service="${settings.engine}"]`);
  section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  requestAnimationFrame(() => {
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card?.querySelector('input')?.focus({ preventScroll: true });
  });
  $$('[data-use]').forEach(button => {
    const current = button.dataset.use === settings.engine;
    button.textContent = current ? '使用中' : '使用';
    button.classList.toggle('is-current', current);
  });
}

async function testEngine(engine, button) {
  const status = $(`[data-status="${engine}"]`);
  status.className = 'service-status';
  status.textContent = '测试中…';
  button.disabled = true;
  try {
    await flushSave();
    const response = await sendMessage({ type: 'test-engine', engine });
    if (response?.error) throw new Error(response.error);
    status.className = 'service-status is-ok';
    status.textContent = `成功：${response.text}`;
  } catch (error) {
    status.className = 'service-status is-error';
    status.textContent = error?.message || '测试失败';
  } finally {
    button.disabled = false;
  }
}

function updateEngineNote() {
  const engine = ENGINE_BY_ID[settings.engine];
  $('#engine-note').textContent = engine ? engine.note : '选择翻译服务。';
}

// ---------------------------------------------------------------- bindings

function formatValue(path, value) {
  if (path === 'style.lineHeight') return `${Number(value).toFixed(2)}`;
  if (path === 'style.fontSize' || path === 'style.opacity') return `${value}%`;
  if (path.startsWith('manga.style.')) return `${value}%`;
  if (path === 'subtitles.fontSize' || path === 'subtitles.position') return `${value}%`;
  if (path === 'ai.temperature') return Number(value).toFixed(1);
  if (typeof value === 'number') return `${value}px`;
  return String(value);
}

function syncControls() {
  $$('[data-path]').forEach(input => {
    const path = input.dataset.path;
    const value = getPath(settings, path);
    if (input.type === 'checkbox') {
      input.checked = Boolean(value);
    } else if (input.dataset.list === 'true') {
      input.value = Array.isArray(value) ? value.join('\n') : String(value || '');
    } else {
      input.value = value ?? '';
    }
    const output = $(`output[data-for="${path}"]`);
    if (output) output.textContent = formatValue(path, value);
  });

  $('#engine').value = settings.engine;
  $('#kbd-toggle').textContent = settings.shortcuts.toggle;
  const toggleChoice = $('.shortcut-choice');
  if (toggleChoice) toggleChoice.value = ['Touch3', 'Touch4'].includes(settings.shortcuts.toggle) ? settings.shortcuts.toggle : '';
  $('#kbd-selection').textContent = settings.shortcuts.selection;
  $('#kbd-subtitles').textContent = settings.subtitles.shortcut || '未设置';
  syncDisplayModes();
  syncPresets();
  syncSubtitleModes();
  syncServiceActive();
  updateEngineNote();
}

function readControl(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.dataset.list === 'true') {
    return input.value
      .split('\n')
      .map(line => line.trim().toLowerCase())
      .filter(Boolean);
  }
  if (input.dataset.type === 'number' || input.type === 'range') return Number(input.value);
  return input.value;
}

function bindControls() {
  $$('[data-path]').forEach(input => {
    if (input.classList.contains('shortcut')) return;
    const eventName = input.tagName === 'SELECT' || input.type === 'checkbox' || input.type === 'color' ? 'change' : 'input';
    input.addEventListener(eventName, () => {
      const path = input.dataset.path;
      setPath(settings, path, readControl(input));
      const output = $(`output[data-for="${path}"]`);
      if (output) output.textContent = formatValue(path, getPath(settings, path));
      if (path.startsWith('style.')) renderPreview();
      if (path === 'engine') {
        updateEngineNote();
        syncServiceActive();
        showSelectedService();
      }
      if (path.startsWith('shortcuts.')) {
        $('#kbd-toggle').textContent = settings.shortcuts.toggle;
        $('#kbd-selection').textContent = settings.shortcuts.selection;
      }
      scheduleSave();
    });
  });
}

// ---------------------------------------------------------------- shortcuts

function bindShortcutInputs() {
  const toggleChoice = $('.shortcut-choice');
  toggleChoice?.addEventListener('change', () => {
    if (!toggleChoice.value) return;
    setPath(settings, toggleChoice.dataset.path, toggleChoice.value);
    $('#shortcut-toggle').value = toggleChoice.value;
    scheduleSave();
  });
  $$('.shortcut').forEach(input => {
    input.addEventListener('focus', () => input.classList.add('is-capturing'));
    input.addEventListener('blur', () => input.classList.remove('is-capturing'));
    input.addEventListener('keydown', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Backspace' || event.key === 'Delete') {
        input.value = '';
        setPath(settings, input.dataset.path, '');
        scheduleSave();
        return;
      }
      const modifiers = [];
      if (event.ctrlKey) modifiers.push('Ctrl');
      if (event.altKey) modifiers.push('Alt');
      if (event.shiftKey) modifiers.push('Shift');
      if (event.metaKey) modifiers.push('Meta');
      const key = event.code?.startsWith('Key') ? event.code.slice(3) : event.key;
      if (!modifiers.length || ['Alt', 'Control', 'Shift', 'Meta'].includes(event.key)) return;
      const combo = [...modifiers, key.toUpperCase()].join('+');
      input.value = combo;
      if (input.id === 'shortcut-toggle' && toggleChoice) toggleChoice.value = '';
      setPath(settings, input.dataset.path, combo);
      $('#kbd-toggle').textContent = settings.shortcuts.toggle;
      $('#kbd-selection').textContent = settings.shortcuts.selection;
      $('#kbd-subtitles').textContent = settings.subtitles.shortcut || '未设置';
      scheduleSave();
    });
  });
}

// ---------------------------------------------------------------- theme

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };

function applyTheme() {
  const mode = settings.ui.theme || 'auto';
  const resolved = mode === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = resolved;
  const toggle = $('#theme-toggle');
  toggle.dataset.themeMode = mode;
  $('.theme-icon', toggle).textContent = mode === 'auto' ? '🌓' : mode === 'dark' ? '🌙' : '🌞';
  toggle.title = `外观：${THEME_LABEL[mode]}`;
  toggle.setAttribute('aria-label', toggle.title);
}

function bindTheme() {
  $('#theme-toggle').addEventListener('click', () => {
    const current = THEMES.includes(settings.ui.theme) ? settings.ui.theme : 'auto';
    settings.ui.theme = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    applyTheme();
    scheduleSave();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((settings.ui.theme || 'auto') === 'auto') applyTheme();
  });
}

// ---------------------------------------------------------------- import / export

function bindTransfer() {
  $('#export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `open-translate-settings-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = normalizeSettings(parsed);
      parseCustomTerms(imported.glossary.customTerms, imported.glossary.customTargetLanguage);
      settings = imported;
      await flushSave();
      hydrate();
      toast('配置已导入');
    } catch (error) {
      toast(`导入失败：${error.message || '不是有效的配置文件'}`);
    } finally {
      event.target.value = '';
    }
  });

  $('#reset').addEventListener('click', async () => {
    if (!confirm('恢复默认设置？当前配置会被覆盖。')) return;
    settings = normalizeSettings(DEFAULT_SETTINGS);
    await flushSave();
    hydrate();
    toast('已恢复默认设置');
  });

  $('#reset-prompt').addEventListener('click', () => {
    settings.ai.prompt = DEFAULT_PROMPT;
    $('#ai-prompt').value = DEFAULT_PROMPT;
    scheduleSave();
  });
}

// ---------------------------------------------------------------- cache

async function refreshCacheStats() {
  const label = $('#cache-count');
  if (!label) return;
  try {
    const stats = await sendMessage({ type: 'cache-stats' });
    if (!stats || stats.error) throw new Error(stats?.error || 'unavailable');
    label.textContent = stats.count ? `${stats.count} 条译文` : '暂无缓存';
  } catch {
    label.textContent = '暂不可用';
  }
}

function bindCache() {
  refreshCacheStats();
  $('#clear-cache').addEventListener('click', async () => {
    const button = $('#clear-cache');
    button.disabled = true;
    try {
      await sendMessage({ type: 'clear-cache' });
      await refreshCacheStats();
      toast('翻译缓存已清空');
    } catch {
      toast('清空失败，请重新加载扩展');
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- navigation

function bindNavigation() {
  const sections = $$('.section');
  const nav = $('#nav');
  const items = $$('.nav-item');
  const centerActiveItem = item => {
    if (!item || nav.scrollWidth <= nav.clientWidth) return;
    const target = item.offsetLeft - (nav.clientWidth - item.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  };
  const setActiveItem = id => {
    const item = items.find(candidate => candidate.dataset.target === id);
    items.forEach(candidate => candidate.classList.toggle('is-active', candidate === item));
    centerActiveItem(item);
  };

  items.forEach(item => {
    item.addEventListener('click', () => {
      requestAnimationFrame(() => centerActiveItem(item));
    });
  });

  const observer = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        setActiveItem(entry.target.id);
      });
    },
    { rootMargin: '-15% 0px -70% 0px', threshold: 0 }
  );
  sections.forEach(section => observer.observe(section));
}

// ---------------------------------------------------------------- bootstrap

function hydrate() {
  renderServices();
  renderMangaEngineSelect();
  syncControls();
  $('#glossary-custom').value = settings.glossary.customTerms;
  try {
    parseCustomTerms(settings.glossary.customTerms, settings.glossary.customTargetLanguage);
    $('#glossary-error').textContent = '';
  } catch (error) { $('#glossary-error').textContent = error.message; }
  renderGlossaries();
  renderPreview();
  applyTheme();
}

async function init() {
  try {
    settings = await loadSettings();
    secretStatus = await getAllSecrets();

    // Migrate any plaintext keys left over from before Keychain storage: move
    // them into the system Keychain, then blank them in settings so they are
    // never persisted to local storage or iCloud.
    let migrated = false;
    for (const [engine, field] of Object.entries(SECRET_FIELDS)) {
      const value = settings.engines?.[engine]?.[field];
      if (value) {
        try {
          await setSecret(engine, value);
          settings.engines[engine][field] = '';
          migrated = true;
        } catch (_) { /* keep plaintext until a later attempt */ }
      }
    }
    if (migrated) {
      try { await saveSettings(settings); } catch (_) {}
    }

    renderEngineSelect();
    renderMangaEngineSelect();
    renderLanguages();
    renderDisplayModes();
    renderSubtitleModes();
    renderPresets();
    bindServices();
    bindControls();
    bindGlossary();
    bindShortcutInputs();
    bindTheme();
    bindTransfer();
    bindCache();
    bindNavigation();

    const versionLabel = $('#version-label');
    if (versionLabel) versionLabel.textContent = `v${APP_VERSION}`;
    $('#about-version').textContent = `v${APP_VERSION}`;
    hydrate();
  } catch (error) {
    console.error('Open Translate settings initialization failed', error);
    const list = $('#services-list');
    if (list && !list.children.length) {
      const detail = error?.message ? `（${error.message}）` : '';
      list.innerHTML = `<div class="card error-card">翻译服务加载失败，请重新打开设置页。${detail}</div>`;
    }
  }
}

init();
