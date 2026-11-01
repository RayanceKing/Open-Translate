import { DEFAULT_SETTINGS, normalizeSettings, stripSecrets } from './defaults.js';
import { nativeSend } from './native.js';

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

/**
 * Persist settings locally AND mirror a secret-stripped copy to iCloud so it
 * follows the user across iPhone / iPad / Mac. Secrets themselves are never
 * written here — they live in the system Keychain (see setSecret).
 */
export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  normalized.syncedAt = Date.now();
  try {
    await storageSet({ [KEY]: normalized, targetLanguage: normalized.targetLanguage });
  } catch (error) {
    console.warn('Open Translate: 设置保存失败，本次更改不会持久化。', error);
  }
  try {
    await nativeSend({ type: 'settings', action: 'set', settings: stripSecrets(normalized) });
  } catch (error) {
    // iCloud may be unavailable (not signed in / entitlement missing) — local
    // storage above still worked, so the extension keeps functioning.
    console.warn('Open Translate: iCloud 设置同步失败（已仅本机保存）。', error);
  }
  return normalized;
}

export async function patchSettings(patch) {
  const current = await loadSettings();
  return saveSettings({ ...current, ...patch });
}

/**
 * Pull the latest settings from iCloud and adopt them when they are at least as
 * new as the local copy. Used on startup so a change made on another device
 * shows up here. Returns the (possibly updated) local settings.
 */
export async function syncFromCloud() {
  let cloud = null;
  try {
    const reply = await nativeSend({ type: 'settings', action: 'get' });
    cloud = reply?.settings;
  } catch (error) {
    console.warn('Open Translate: 读取 iCloud 设置失败。', error);
  }
  if (!cloud || typeof cloud !== 'object') return loadSettings();
  const local = await loadSettings();
  if ((cloud.syncedAt || 0) >= (local.syncedAt || 0)) {
    const a = JSON.stringify(stripSecrets(cloud));
    const b = JSON.stringify(stripSecrets(local));
    if (a !== b) {
      try {
        const normalized = normalizeSettings(cloud);
        await storageSet({ [KEY]: normalized, targetLanguage: normalized.targetLanguage });
      } catch (error) {
        console.warn('Open Translate: 应用 iCloud 设置失败。', error);
      }
    }
  }
  return loadSettings();
}

// ---------------------------------------------------------------- Secrets

/** Read all stored secrets (engine -> key) from the system Keychain. */
export async function getAllSecrets() {
  try {
    const reply = await nativeSend({ type: 'secret', action: 'get' });
    return reply?.secrets || {};
  } catch (error) {
    console.warn('Open Translate: 读取密钥失败。', error);
    return {};
  }
}

export async function getSecret(engine) {
  const all = await getAllSecrets();
  return all[engine] || '';
}

/**
 * Store or delete a secret for an engine. An empty/whitespace value deletes the
 * key from the Keychain. Throws if the native call fails so the UI can warn.
 */
export async function setSecret(engine, value) {
  const trimmed = String(value || '').trim();
  await nativeSend({
    type: 'secret',
    action: trimmed ? 'set' : 'delete',
    engine,
    value: trimmed
  });
}

export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[KEY]) callback(normalizeSettings(changes[KEY].newValue));
  };
  chrome.storage?.onChanged?.addListener?.(listener);
  return () => chrome.storage?.onChanged?.removeListener?.(listener);
}

export { DEFAULT_SETTINGS };
