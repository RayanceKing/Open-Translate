import { DEFAULT_SETTINGS, normalizeSettings } from './defaults.js';

const KEY = 'settings';

// Safari's `chrome` shim does not always expose storage the same way Chrome
// does. Read it defensively so a missing area never throws synchronously.
function storageArea() {
  try {
    return chrome?.storage?.local;
  } catch {
    return undefined;
  }
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    const area = storageArea();
    if (!area) {
      reject(new Error('chrome.storage.local 不可用（请确认扩展已声明 storage 权限）'));
      return;
    }
    let settled = false;
    const finish = (apply, value) => {
      if (settled) return;
      settled = true;
      apply(value);
    };
    // Guard against a storage backend that never invokes its callback.
    const timeout = setTimeout(() => finish(reject, new Error('读取设置超时')), 5000);
    try {
      const result = area.get(keys, value => {
        clearTimeout(timeout);
        finish(resolve, value);
      });
      if (result && typeof result.then === 'function') {
        result.then(
          value => { clearTimeout(timeout); finish(resolve, value); },
          error => { clearTimeout(timeout); finish(reject, error); }
        );
      }
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    const area = storageArea();
    if (!area) { resolve(); return; } // 存储不可用时静默跳过，避免阻断 UI
    let settled = false;
    const finish = apply => {
      if (settled) return;
      settled = true;
      apply();
    };
    const timeout = setTimeout(() => finish(resolve), 5000);
    try {
      const result = area.set(value, () => {
        clearTimeout(timeout);
        finish(resolve);
      });
      if (result && typeof result.then === 'function') {
        result.then(
          () => { clearTimeout(timeout); finish(resolve); },
          error => { clearTimeout(timeout); finish(reject, error); }
        );
      }
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

/** Read settings, migrating the pre-0.2 single `targetLanguage` key. */
export async function loadSettings() {
  try {
    // Pass an object form — the most universally supported across Chrome/Firefox/Safari.
    const stored = await storageGet({ [KEY]: null, targetLanguage: null });
    const settings = normalizeSettings(stored?.[KEY]);
    if (!stored?.[KEY] && stored?.targetLanguage) settings.targetLanguage = stored.targetLanguage;
    return settings;
  } catch (error) {
    // Never blank the settings page over a storage hiccup (e.g. Safari edge cases).
    console.warn('Open Translate: 读取本地设置失败，已回退到默认值。', error);
    return normalizeSettings(null);
  }
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  try {
    await storageSet({ [KEY]: normalized, targetLanguage: normalized.targetLanguage });
  } catch (error) {
    console.warn('Open Translate: 设置保存失败，本次更改不会持久化。', error);
  }
  return normalized;
}

export async function patchSettings(patch) {
  const current = await loadSettings();
  return saveSettings({ ...current, ...patch });
}

export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[KEY]) callback(normalizeSettings(changes[KEY].newValue));
  };
  chrome.storage?.onChanged?.addListener?.(listener);
  return () => chrome.storage?.onChanged?.removeListener?.(listener);
}

export { DEFAULT_SETTINGS };
