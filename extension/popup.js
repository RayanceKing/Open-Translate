import { LANGUAGES } from './lib/defaults.js';
import { ENGINE_CATALOG } from './lib/catalog.js';
import { loadSettings, saveSettings } from './lib/store.js';

const $ = selector => document.querySelector(selector);

let settings = null;

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToPage(message) {
  const tab = await currentTab();
  if (!tab?.id) throw new Error('找不到当前标签页');
  return chrome.tabs.sendMessage(tab.id, message);
}

function setStatus(text, isError = false) {
  const node = $('#status');
  node.textContent = text;
  node.classList.toggle('is-error', isError);
}

function render() {
  $('#engine').innerHTML = ENGINE_CATALOG.map(engine => `<option value="${engine.id}">${engine.name}</option>`).join('');
  $('#language').innerHTML = LANGUAGES.map(item => `<option value="${item.code}">${item.label}</option>`).join('');

  $('#engine').value = settings.engine;
  $('#language').value = settings.targetLanguage;

  document.querySelectorAll('#modes button').forEach(button => {
    button.classList.toggle('is-selected', button.dataset.mode === settings.displayMode);
  });
}

function bind() {
  $('#engine').addEventListener('change', async event => {
    settings.engine = event.target.value;
    settings = await saveSettings(settings);
    setStatus(`已切换到 ${event.target.selectedOptions[0].textContent}`);
  });

  $('#language').addEventListener('change', async event => {
    settings.targetLanguage = event.target.value;
    settings = await saveSettings(settings);
  });

  $('#modes').addEventListener('click', async event => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    settings.displayMode = button.dataset.mode;
    settings = await saveSettings(settings);
    render();
  });

  $('#translate').addEventListener('click', async () => {
    try {
      settings = await saveSettings(settings);
      await sendToPage({ type: 'translate', target: settings.targetLanguage });
      window.close();
    } catch {
      setStatus('这个页面不支持翻译（仅限普通网页）', true);
    }
  });

  $('#restore').addEventListener('click', async () => {
    try {
      await sendToPage({ type: 'restore' });
      window.close();
    } catch {
      setStatus('这个页面没有可还原的译文', true);
    }
  });

  $('#open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

async function init() {
  settings = await loadSettings();
  render();
  bind();

  const tab = await currentTab();
  if (tab?.url) {
    try {
      $('#page-host').textContent = new URL(tab.url).hostname.replace(/^www\./, '');
    } catch {
      $('#page-host').textContent = tab.title || '当前页面';
    }
  }
}

init();
