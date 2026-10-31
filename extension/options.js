import {
  APP_VERSION,
  DEFAULT_PROMPT,
  DEFAULT_SETTINGS,
  DISPLAY_MODES,
  LANGUAGES,
  STYLE_PRESETS,
  SUBTITLE_MODES,
  normalizeSettings,
  styleToVars
} from './lib/defaults.js';
import { ENGINE_CATALOG, ENGINE_BY_ID } from './lib/catalog.js';
import { loadSettings, saveSettings } from './lib/store.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const getPath = (object, path) => path.split('.').reduce((value, key) => (value == null ? value : value[key]), object);
const setPath = (object, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((node, key) => (node[key] ??= {}), object);
  target[last] = value;
};

let settings = normalizeSettings(null);
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

// ---------------------------------------------------------------- static UI

function renderEngineSelect() {
  const select = $('#engine');
  select.innerHTML = ENGINE_CATALOG.map(engine => {
    const suffix = engine.tag === 'AI' ? ' · AI' : engine.tag === '免费' ? '' : ` · ${engine.tag}`;
    return `<option value="${engine.id}">${engine.name}${suffix}</option>`;
  }).join('');
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
  container.innerHTML = ENGINE_CATALOG.map(engine => {
    const config = settings.engines[engine.id] || {};
    const fields = engine.fields
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
        const type = field.type === 'password' ? 'password' : 'text';
        const value = String(config[field.key] ?? '').replace(/"/g, '&quot;');
        return `<div class="service-field"${depends}${hidden}>
          <label for="eng-${engine.id}-${field.key}">${field.label}</label>
          <input type="${type}" id="eng-${engine.id}-${field.key}" data-engine="${engine.id}" data-key="${field.key}" value="${value}" placeholder="${field.placeholder || ''}" spellcheck="false" autocomplete="off">
        </div>`;
      })
      .join('');

    return `<div class="service ${settings.engine === engine.id ? 'is-active' : ''}" data-service="${engine.id}">
      <div class="service-head">
        <span class="service-name">${engine.name}</span>
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
    settings.engines[engine] ??= {};
    settings.engines[engine][key] = kind === 'switch' ? input.checked : input.value.trim();
    if (kind === 'switch') syncServiceDeps(input.closest('[data-service]'));
    scheduleSave();
  });

  container.addEventListener('input', event => {
    const input = event.target.closest('[data-engine]');
    if (!input || input.dataset.kind === 'switch') return;
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
    const response = await chrome.runtime.sendMessage({ type: 'test-engine', engine });
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
  $('#theme-toggle').textContent = `外观：${THEME_LABEL[mode]}`;
}

function bindTheme() {
  $('#theme-toggle').addEventListener('click', () => {
    const index = THEMES.indexOf(settings.ui.theme || 'auto');
    settings.ui.theme = THEMES[(index + 1) % THEMES.length];
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
      settings = normalizeSettings(parsed);
      await flushSave();
      hydrate();
      toast('配置已导入');
    } catch {
      toast('导入失败：不是有效的配置文件');
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
    const stats = await chrome.runtime.sendMessage({ type: 'cache-stats' });
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
      await chrome.runtime.sendMessage({ type: 'clear-cache' });
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
  const observer = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        $$('.nav-item').forEach(item => item.classList.toggle('is-active', item.dataset.target === entry.target.id));
      });
    },
    { rootMargin: '-15% 0px -70% 0px', threshold: 0 }
  );
  sections.forEach(section => observer.observe(section));
}

// ---------------------------------------------------------------- bootstrap

function hydrate() {
  renderServices();
  syncControls();
  renderPreview();
  applyTheme();
}

async function init() {
  settings = await loadSettings();

  renderEngineSelect();
  renderLanguages();
  renderDisplayModes();
  renderSubtitleModes();
  renderPresets();
  bindServices();
  bindControls();
  bindShortcutInputs();
  bindTheme();
  bindTransfer();
  bindCache();
  bindNavigation();

  $('#version-label').textContent = `v${APP_VERSION}`;
  $('#about-version').textContent = `v${APP_VERSION}`;
  hydrate();
}

init();
