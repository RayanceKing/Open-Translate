import { DEFAULT_SETTINGS, normalizeSettings } from './defaults.js';

const KEY = 'settings';

/** Read settings, migrating the pre-0.2 single `targetLanguage` key. */
export async function loadSettings() {
  const stored = await chrome.storage.local.get([KEY, 'targetLanguage']);
  const settings = normalizeSettings(stored[KEY]);
  if (!stored[KEY] && stored.targetLanguage) settings.targetLanguage = stored.targetLanguage;
  return settings;
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [KEY]: normalized, targetLanguage: normalized.targetLanguage });
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
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export { DEFAULT_SETTINGS };
