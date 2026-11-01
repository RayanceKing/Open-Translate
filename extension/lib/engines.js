// Translation providers. Every provider exposes:
//   translate({ texts, source, target, config, settings }) -> Promise<string[]>
// Results keep the same order and length as `texts`.

import { DEFAULT_PROMPT, LANG_LABEL, VISION_ENGINES } from './defaults.js';
export { VISION_ENGINES };
import { formatGlossary } from './glossary.js';

const TIMEOUT = 25000;

async function http(url, options = {}, timeout = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data = raw;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep raw text */
    }
    if (!response.ok) throw new Error(describeError(response.status, data, raw));
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('翻译请求超时，请检查网络或接口地址');
    if (error instanceof TypeError) throw new Error('无法连接翻译服务，请检查网络、域名或 CORS 设置');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function describeError(status, data, raw) {
  const detail =
    data?.error?.message ||
    data?.error?.type ||
    data?.message ||
    data?.error_description ||
    (typeof data === 'string' ? data.slice(0, 120) : '') ||
    String(raw || '').slice(0, 120);
  if (status === 401 || status === 403) return `密钥无效或权限不足（HTTP ${status}）${detail ? '：' + detail : ''}`;
  if (status === 429) return '请求过于频繁或额度用尽（HTTP 429），请稍后重试或更换引擎';
  return `服务返回错误（HTTP ${status}）${detail ? '：' + detail : ''}`;
}

const trimSlash = value => String(value || '').replace(/\/+$/, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function targetLabel(code) {
  return LANG_LABEL[code] || code;
}

// ---------------------------------------------------------------- language maps

const DEEPL_LANG = { 'zh-CN': 'ZH', 'zh-TW': 'ZH-HANT', en: 'EN-US', pt: 'PT-PT', ja: 'JA', ko: 'KO' };
const MS_LANG = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };
const LIBRE_LANG = { 'zh-CN': 'zh', 'zh-TW': 'zt' };

const deeplLang = code => DEEPL_LANG[code] || String(code).toUpperCase();
const msLang = code => MS_LANG[code] || code;
const libreLang = code => LIBRE_LANG[code] || String(code).split('-')[0];
const mymemoryLang = code => {
  const value = String(code || '').trim();
  return !value || value.toLowerCase() === 'auto' ? 'en' : value;
};

// ---------------------------------------------------------------- free engines

async function googleOne(text, target) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(target) +
    '&dt=t&q=' +
    encodeURIComponent(text);
  const data = await http(url);
  if (!Array.isArray(data?.[0])) throw new Error('Google 翻译返回了意外的数据格式');
  return data[0].map(segment => segment?.[0] || '').join('');
}

const google = {
  id: 'google',
  async translate({ texts, target }) {
    const output = [];
    for (const text of texts) output.push(await googleOne(text, target));
    return output;
  }
};

const mymemory = {
  id: 'mymemory',
  async translate({ texts, source, target }) {
    const sourceLang = mymemoryLang(source);
    const output = [];
    for (const text of texts) {
      const url =
        'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(text.slice(0, 500)) +
        '&langpair=' +
        encodeURIComponent(sourceLang) +
        '%7C' +
        encodeURIComponent(target);
      const data = await http(url);
      if (data?.responseStatus !== 200) throw new Error(data?.responseDetails || 'MyMemory 服务不可用');
      output.push(data.responseData.translatedText);
      await sleep(120);
    }
    return output;
  }
};

// ---------------------------------------------------------------- keyed engines

const deepl = {
  id: 'deepl',
  async translate({ texts, target, config }) {
    const key = String(config.key || '').trim();
    if (!key) throw new Error('尚未填写 DeepL API Key');
    const base = config.pro ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
    const data = await http(`${base}/v2/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${key}` },
      body: JSON.stringify({ text: texts, target_lang: deeplLang(target) })
    });
    const translations = data?.translations;
    if (!Array.isArray(translations) || translations.length !== texts.length) throw new Error('DeepL 返回的译文数量不匹配');
    return translations.map(item => item.text);
  }
};

// Microsoft Translator ships two channels:
//   free  — the same public endpoint the Bing translator page uses (token + key
//           scraped from the page, valid for a while, no account needed)
//   azure — the official Cognitive Services API, requires a subscription key
// The free channel is the default, matching what Immersive Translate does.

let bingCredentials = null;

// Bing's ttranslatev3 endpoint rejects requests without a browser-like
// User-Agent (HTTP 401 {"ShowCaptcha":false}). Browsers set it themselves and
// silently ignore the header here, so this only matters for non-browser
// callers such as Node during development.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

async function fetchBingCredentials(force = false) {
  const fresh = bingCredentials && Date.now() - bingCredentials.at < 8 * 60 * 1000;
  if (!force && fresh) return bingCredentials;

  const response = await fetch('https://www.bing.com/translator', {
    headers: { Accept: 'text/html,application/xhtml+xml', ...BROWSER_HEADERS },
    credentials: 'include',
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`微软免费通道不可用（HTTP ${response.status}）`);
  const html = await response.text();
  const ig = /IG:"([0-9A-Fa-f]+)"/.exec(html);
  const iid = /data-iid="([^"]+)"/.exec(html);
  const abuse = /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)/.exec(html);
  if (!ig || !abuse) throw new Error('微软免费通道返回了无法识别的页面，请在设置中改用 Azure 密钥');

  bingCredentials = {
    host: new URL(response.url || 'https://www.bing.com/translator').origin,
    ig: ig[1],
    iid: iid?.[1] || 'translator.5023',
    key: abuse[1],
    token: abuse[2],
    at: Date.now()
  };
  return bingCredentials;
}

async function bingTranslateOne(text, to, credentials) {
  const body = new URLSearchParams({
    fromLang: 'auto-detect',
    to,
    text: text.slice(0, 4000),
    token: credentials.token,
    key: credentials.key
  });
  const response = await fetch(
    `${credentials.host}/ttranslatev3?isVertical=1&IG=${credentials.ig}&IID=${credentials.iid}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${credentials.host}/translator`,
        ...BROWSER_HEADERS
      },
      credentials: 'include',
      body
    }
  );
  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error('微软免费通道凭证已过期');
    error.retryable = true;
    throw error;
  }
  if (!response.ok || !Array.isArray(data)) throw new Error(`微软免费通道返回错误（HTTP ${response.status}）`);
  const result = data?.[0]?.translations?.[0]?.text;
  if (!result) throw new Error('微软免费通道没有返回译文');
  return result;
}

async function microsoftFree(texts, target) {
  const to = msLang(target);
  const run = async credentials => {
    const output = [];
    for (const text of texts) output.push(await bingTranslateOne(text, to, credentials));
    return output;
  };
  try {
    return await run(await fetchBingCredentials());
  } catch (error) {
    if (!error.retryable) throw error;
    bingCredentials = null;
    return run(await fetchBingCredentials(true));
  }
}

async function microsoftAzure(texts, target, config) {
  const key = String(config.key || '').trim();
  if (!key) throw new Error('尚未填写 Azure 订阅密钥，或关闭「使用 Azure 密钥」改用免费通道');
  const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(msLang(target))}`;
  const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': key };
  if (config.region && config.region !== 'global') headers['Ocp-Apim-Subscription-Region'] = config.region;
  const data = await http(url, { method: 'POST', headers, body: JSON.stringify(texts.map(text => ({ Text: text }))) });
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error('Microsoft 翻译返回的译文数量不匹配');
  return data.map(item => item?.translations?.[0]?.text || '');
}

const microsoft = {
  id: 'microsoft',
  async translate({ texts, target, config }) {
    return config.useKey ? microsoftAzure(texts, target, config) : microsoftFree(texts, target);
  }
};

const libre = {
  id: 'libre',
  async translate({ texts, target, config }) {
    const base = trimSlash(config.url);
    if (!base) throw new Error('尚未填写 LibreTranslate 实例地址');
    const body = { q: texts, source: 'auto', target: libreLang(target), format: 'text' };
    if (config.key) body.api_key = config.key;
    const data = await http(`${base}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = data?.translatedText;
    if (Array.isArray(result)) return result;
    if (typeof result === 'string') return [result];
    throw new Error('LibreTranslate 返回了意外的数据格式');
  }
};

// ---------------------------------------------------------------- AI engines

const apple = {
  id: 'apple',
  async translate({ texts, source = 'auto', target }) {
    const runtimes = [
      typeof browser !== 'undefined' ? browser.runtime : null,
      typeof chrome !== 'undefined' ? chrome.runtime : null
    ].filter(candidate => typeof candidate?.sendNativeMessage === 'function');
    const runtime = runtimes[0];
    const usesPromiseApi = typeof browser !== 'undefined' && browser.runtime === runtime;
    if (typeof runtime?.sendNativeMessage !== 'function') {
      throw new Error('系统翻译仅支持 iOS / macOS 上的 Safari 扩展');
    }
    const reply = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('系统翻译响应超时，请确认设备已下载对应语言包'));
      }, 25000);
      const complete = response => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const lastError = runtime.lastError;
        if (lastError) reject(new Error(lastError.message || '调用系统翻译失败'));
        else resolve(response);
      };
      try {
        const pending = usesPromiseApi
          ? runtime.sendNativeMessage('com.stuwang.openTranslate.Extension', { type: 'translate', texts, source, target })
          : runtime.sendNativeMessage('com.stuwang.openTranslate.Extension', { type: 'translate', texts, source, target }, complete);
        if (pending && typeof pending.then === 'function') pending.then(complete, reject);
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    if (reply?.error) throw new Error(reply.error);
    if (!Array.isArray(reply?.texts) || reply.texts.length !== texts.length) {
      throw new Error('系统翻译返回了意外的数据格式');
    }
    return reply.texts;
  }
};

function buildPrompt({ texts, source, target, config }) {
  const template = String(config.prompt || '').trim() || DEFAULT_PROMPT;
  const head = template
    .replaceAll('{{target}}', targetLabel(target))
    .replaceAll('{{source}}', source && source !== 'auto' ? targetLabel(source) : 'the original language (auto-detect)');
  const parts = [head];
  const glossary = formatGlossary(texts, config.glossaryEntries || []);
  if (glossary) parts.push(`Glossary — always use these translations verbatim:\n${glossary}`);
  if (texts.length === 1) {
    parts.push(`Text:\n<<<\n${texts[0]}\n>>>`);
  } else {
    parts.push(
      `The text contains ${texts.length} segments. Translate every segment and keep the leading number exactly as given:\n` +
        texts.map((text, index) => `${index + 1}. ${text}`).join('\n')
    );
  }
  return parts.join('\n\n');
}

function parseNumbered(raw, count) {
  const map = new Map();
  let current = null;
  for (const line of String(raw).split('\n')) {
    const match = /^\s*(\d+)\s*[.、)．:：]\s*(.*)$/.exec(line);
    const index = match ? Number(match[1]) : NaN;
    if (match && index >= 1 && index <= count) {
      current = index;
      map.set(index, match[2]);
    } else if (current !== null && line.trim()) {
      map.set(current, `${map.get(current) || ''}\n${line.trim()}`);
    }
  }
  if (map.size !== count) return null;
  return Array.from({ length: count }, (_, index) => (map.get(index + 1) || '').trim());
}

function cleanSingle(raw) {
  return String(raw)
    .replace(/^\s*<<<\s*/, '')
    .replace(/\s*>>>\s*$/, '')
    .replace(/^["'“”]([\s\S]*)["'“”]$/, '$1')
    .trim();
}

async function runAi(ask, { texts, source, target, config }) {
  if (texts.length === 1) return [cleanSingle(await ask(buildPrompt({ texts, source, target, config })))];
  const batch = await ask(buildPrompt({ texts, source, target, config }));
  const parsed = parseNumbered(batch, texts.length);
  if (parsed) return parsed;
  // The model ignored the numbering contract — fall back to one request per segment.
  const output = [];
  for (const text of texts) output.push(cleanSingle(await ask(buildPrompt({ texts: [text], source, target, config }))));
  return output;
}

async function openAiChat({ texts, source, target, config }) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey && !config.allowAnonymous) throw new Error('尚未填写 API Key');
  const base = trimSlash(config.baseUrl) || (config.allowAnonymous ? '' : 'https://api.openai.com/v1');
  if (!base) throw new Error('尚未填写接口地址');
  return runAi(async prompt => {
    const data = await http(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        temperature: Number(config.temperature ?? 0.2),
        messages: [
          { role: 'system', content: 'You are a precise translator. You output only the translation.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('模型没有返回译文');
    return content;
  }, { texts, source, target, config });
}

const openai = { id: 'openai', translate: openAiChat };
const deepseek = { id: 'deepseek', translate: openAiChat };
const custom = {
  id: 'custom',
  translate: options => openAiChat({ ...options, config: { ...options.config, allowAnonymous: true } })
};

const gemini = {
  id: 'gemini',
  async translate({ texts, source, target, config }) {
    const apiKey = String(config.apiKey || '').trim();
    if (!apiKey) throw new Error('尚未填写 Gemini API Key');
    const model = config.model || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    return runAi(async prompt => {
      const data = await http(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'You are a precise translator. You output only the translation.' }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: Number(config.temperature ?? 0.2) }
        })
      });
      const parts = data?.candidates?.[0]?.content?.parts;
      const content = Array.isArray(parts) ? parts.map(part => part.text || '').join('') : '';
      if (!content) throw new Error('模型没有返回译文');
      return content;
    }, { texts, source, target, config });
  }
};

const claude = {
  id: 'claude',
  async translate({ texts, source, target, config }) {
    const apiKey = String(config.apiKey || '').trim();
    if (!apiKey) throw new Error('尚未填写 Anthropic API Key');
    return runAi(async prompt => {
      const data = await http('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: config.model || 'claude-3-5-haiku-latest',
          max_tokens: 4096,
          temperature: Number(config.temperature ?? 0.2),
          system: 'You are a precise translator. You output only the translation.',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const content = Array.isArray(data?.content)
        ? data.content.filter(block => block.type === 'text').map(block => block.text).join('')
        : '';
      if (!content) throw new Error('模型没有返回译文');
      return content;
    }, { texts, source, target, config });
  }
};

// ---------------------------------------------------------------- vision (OCR + translate)
//
// Multimodal engines can read an image and return both the detected text and its
// translation in a single call. We ask for a strict JSON array of bounding boxes
// (normalized 0–1) so the content script can paint each translation back onto
// the original panel. Only the engines in VISION_ENGINES support this path.

function splitDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) return ['image/png', ''];
  return [match[1] || 'image/png', match[2]];
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

const VISION_SYSTEM =
  'You are a precise comic / manga OCR and translation assistant. The image ' +
  'likely contains text (speech bubbles, captions, signs) in its original ' +
  'language. Detect every distinct text region, translate it, and report its ' +
  'bounding box. Respond with STRICT JSON only — a single JSON array, no code ' +
  'fences and no commentary. Each element must be: ' +
  '{"box":[x,y,w,h],"text":"original","translation":"translated"}. ' +
  'Coordinates are normalized to 0–1 relative to the image, where x,y is the ' +
  'top-left corner and w,h are width and height. If there is no text, return [].';

function visionUserPrompt(target) {
  return `Translate every text region into ${targetLabel(target)}. Keep the translation faithful and concise. Return only the JSON array described.`;
}

async function visionOpenAi({ image, prompt, config }) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey && !config.allowAnonymous) throw new Error('尚未填写 API Key');
  const base = trimSlash(config.baseUrl) || (config.allowAnonymous ? '' : 'https://api.openai.com/v1');
  if (!base) throw new Error('尚未填写接口地址');
  const data = await http(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      temperature: Number(config.temperature ?? 0.2),
      messages: [
        { role: 'system', content: VISION_SYSTEM },
        { role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: image } }
        ] }
      ]
    })
  }, TIMEOUT + 40000);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('模型没有返回结果');
  return content;
}

async function visionGemini({ image, prompt, config }) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('尚未填写 Gemini API Key');
  const model = config.model || 'gemini-2.0-flash';
  const [mime, b64] = splitDataUrl(image);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const data = await http(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: VISION_SYSTEM }] },
      contents: [{ role: 'user', parts: [
        { text: prompt },
        { inline_data: { mimeType: mime, data: b64 } }
      ] }],
      generationConfig: { temperature: Number(config.temperature ?? 0.2) }
    })
  }, TIMEOUT + 40000);
  const parts = data?.candidates?.[0]?.content?.parts;
  const content = Array.isArray(parts) ? parts.map(part => part.text || '').join('') : '';
  if (!content) throw new Error('模型没有返回结果');
  return content;
}

async function visionClaude({ image, prompt, config }) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('尚未填写 Anthropic API Key');
  const [mime, b64] = splitDataUrl(image);
  const data = await http('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: config.model || 'claude-3-5-haiku-latest',
      max_tokens: 4096,
      temperature: Number(config.temperature ?? 0.2),
      system: VISION_SYSTEM,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: prompt }
      ] }]
    })
  }, TIMEOUT + 40000);
  const content = Array.isArray(data?.content)
    ? data.content.filter(block => block.type === 'text').map(block => block.text).join('')
    : '';
  if (!content) throw new Error('模型没有返回结果');
  return content;
}

function parseVisionResult(raw) {
  let text = String(raw || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1].trim();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('视觉模型返回的不是有效 JSON');
  }
  if (!Array.isArray(data)) throw new Error('视觉模型返回的格式不正确');
  const boxes = [];
  for (const item of data) {
    const box = Array.isArray(item?.box) ? item.box : null;
    if (!box || box.length !== 4) continue;
    const coords = box.map(clamp01);
    if (coords.some(value => !Number.isFinite(value))) continue;
    const text = String(item.text || '').trim();
    const translation = String(item.translation || '').trim();
    if (!translation && !text) continue;
    boxes.push({ box: coords, text, translation: translation || text });
  }
  return boxes;
}

export async function visionOcrTranslate({ engine, image, source = 'auto', target, config = {} }) {
  if (!VISION_ENGINES.includes(engine)) throw new Error('该引擎不支持视觉翻译，请选择 OpenAI / Gemini / Claude');
  const caller = engine === 'gemini' ? visionGemini : engine === 'claude' ? visionClaude : visionOpenAi;
  const raw = await caller({ image, prompt: visionUserPrompt(target), config });
  return parseVisionResult(raw);
}

// ---------------------------------------------------------------- registry

export const PROVIDERS = { google, mymemory, deepl, microsoft, libre, apple, openai, deepseek, gemini, claude, custom };

export function hasProvider(id) {
  return Boolean(PROVIDERS[id]);
}

export async function translateTexts({ engine, texts, source = 'auto', target, config = {} }) {
  const provider = PROVIDERS[engine];
  if (!provider) throw new Error(`未知的翻译引擎：${engine}`);
  if (!Array.isArray(texts) || !texts.length) return [];
  const output = await provider.translate({ texts, source, target, config });
  return texts.map((_, index) => String(output[index] ?? ''));
}
