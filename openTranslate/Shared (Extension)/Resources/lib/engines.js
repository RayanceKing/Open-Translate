// Translation providers. Every provider exposes:
//   translate({ texts, source, target, config, settings }) -> Promise<string[]>
// Results keep the same order and length as `texts`.

import { DEFAULT_PROMPT, LANG_LABEL, VISION_ENGINES } from './defaults.js';
export { VISION_ENGINES };
import { formatGlossary } from './glossary.js';

const TIMEOUT = 25000;

// Safari can inject a native HTTP transport (see background.js). When present,
// requests to B站's public Index-Translate API are issued by the app extension's
// URLSession instead of the browser, so no `Origin: safari-web-extension://…`
// header ever reaches the WAF. Other clients never register a transport and
// keep using fetch + the narrowly scoped DNR rule below.
let nativeHttpTransport = null;
const NATIVE_FORWARD_HOSTS = [/^index-translate\.bilibili\.com$/i];
const MAX_NATIVE_BODY = 2 * 1024 * 1024;

/** Register (or clear) the native relay. Safari background script only. */
export function setNativeHttpTransport(fn) {
  nativeHttpTransport = typeof fn === 'function' ? fn : null;
}

function shouldForwardViaNative(url, options) {
  if (!nativeHttpTransport) return false;
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  if (!NATIVE_FORWARD_HOSTS.some(pattern => pattern.test(host))) return false;
  // plist-based native messages are not designed for multi-megabyte payloads.
  const body = options.body;
  return typeof body !== 'string' || body.length <= MAX_NATIVE_BODY;
}

function parseNativeReply(reply) {
  // Swift returns both the raw JSON text and a plist-safe dictionary. Prefer the
  // raw text: plist cannot represent NSNull, so the dictionary folds nulls to
  // empty strings and would silently lose information.
  if (reply?.raw) {
    try { return JSON.parse(reply.raw); } catch { /* fall through */ }
  }
  return reply?.data ?? reply?.raw ?? null;
}

// FluentRead-style batching: bound every request by BOTH segment count and
// character count. Exceeding either limit starts another sub-batch; an
// oversized single segment stays intact (never truncated). Small sub-batches
// run concurrently, so a long page never becomes one giant slow request that
// blows the caller's deadline.
const MAX_BATCH_SEGMENTS = 8;
const MAX_BATCH_CHARS = 2000;
const MAX_BATCH_CONCURRENCY = 3;
const MAX_SEGMENT_CONCURRENCY = 4;

function splitBatches(texts, maxSegments = MAX_BATCH_SEGMENTS, maxChars = MAX_BATCH_CHARS) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const text of texts) {
    const length = String(text ?? '').length;
    if (current.length && (current.length >= maxSegments || chars + length > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += length;
  }
  if (current.length) batches.push(current);
  return batches;
}

// Bounded parallelism that preserves input order.
async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function http(url, options = {}, timeout = TIMEOUT) {
  if (shouldForwardViaNative(url, options)) {
    try {
      const reply = await nativeHttpTransport({
        url,
        method: options.method || 'GET',
        headers: options.headers || {},
        body: typeof options.body === 'string' ? options.body : null,
        timeout: 10
      });
      return parseNativeReply(reply);
    } catch (error) {
      if (error?.otNative) {
        const status = error.status || 0;
        // Deliberately no fetch fallback: a browser fetch to this host is
        // exactly the request the WAF rejects with 412.
        throw new Error(status
          ? describeError(status, error.data, error.rawBody || '', url)
          : `原生转发失败：${error.message}`);
      }
      throw error;
    }
  }
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
    if (!response.ok) throw new Error(describeError(response.status, data, raw, url));
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('翻译请求超时，请检查网络或接口地址');
    if (error instanceof TypeError) throw new Error('无法连接翻译服务，请检查网络、域名或 CORS 设置');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Bilibili's WAF answers with an HTML risk-control page (HTTP 412) instead of
// JSON whenever the request carries a browser-extension Origin
// (chrome-extension://, safari-web-extension://, moz-extension://). The public
// API is keyless and works from a normal origin; upstream recommends a local
// bridge proxy for extensions. Give an actionable hint instead of dumping HTML.
export const INDEX_TRANSLATE_412 = 'B 站安全风控拒绝了本次请求（HTTP 412）。Safari 原生版已自动改由 App 的网络层转发（请求不带浏览器扩展的 Origin）；若仍被拦截，可能是公共接口临时限流，请把「接口地址」改为官方本地桥接代理 http://127.0.0.1:8080/v1（运行 python inference/llm/call_api.py --serve），或改为自建 vLLM 地址；油猴脚本不受此限制。';

function describeError(status, data, raw, url = '') {
  const text = String(raw || '');
  const isIndex = /index-translate\.bilibili\.com/i.test(String(url || ''));
  if (isIndex && (status === 412 || /哔哩哔哩安全风控|错误号:\s*412/.test(text))) return INDEX_TRANSLATE_412;
  const detail =
    data?.error?.message ||
    data?.error?.type ||
    data?.message ||
    data?.error_description ||
    (typeof data === 'string' ? data.slice(0, 120) : '') ||
    text.slice(0, 120);
  if (status === 401 || status === 403) return `密钥无效或权限不足（HTTP ${status}）${detail ? '：' + detail : ''}`;
  if (status === 429) return '请求过于频繁或额度用尽（HTTP 429），请稍后重试或更换引擎';
  return `服务返回错误（HTTP ${status}）${detail ? '：' + detail : ''}`;
}

// Chromium/Safari attach `Origin: chrome-extension://<id>` (or
// safari-web-extension://) to requests started from the background page. B站's
// WAF answers those with an HTML 412 risk-control page even though the public
// API is free and keyless. A narrowly scoped dynamic DNR rule drops just that
// header for this single host (Chromium only). Safari does not apply
// modifyHeaders to extension-initiated requests, so the Safari build registers
// a native HTTP transport instead and relays these calls through URLSession
// in the app extension (no browser Origin at all).
const INDEX_DNR_RULE_ID = 1;
export async function installIndexTranslateHeaderRule() {
  const dnr = typeof chrome !== 'undefined' ? chrome.declarativeNetRequest : null;
  if (typeof dnr?.updateDynamicRules !== 'function' || !chrome?.runtime?.id) return false;
  const action = {
    type: 'modifyHeaders',
    requestHeaders: [{ header: 'Origin', operation: 'remove' }]
  };
  const condition = {
    urlFilter: '||index-translate.bilibili.com/',
    resourceTypes: ['xmlhttprequest']
  };
  const attempts = [
    { ...condition, initiatorDomains: [chrome.runtime.id] },
    condition
  ];
  for (let index = 0; index < attempts.length; index += 1) {
    try {
      await dnr.updateDynamicRules({
        removeRuleIds: [INDEX_DNR_RULE_ID],
        addRules: [{ id: INDEX_DNR_RULE_ID, priority: 1, action, condition: attempts[index] }]
      });
      return true;
    } catch (error) {
      // Older Chrome builds (pre-101) reject `initiatorDomains`; retry with the
      // host-scoped fallback. Any other failure is non-fatal — translation and
      // model detection still report the 412 hint so users can use the bridge.
      if (index === attempts.length - 1) console.warn('Open Translate: 无法注册 Index 翻译请求头规则', error);
    }
  }
  return false;
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
  translate({ texts, target }) {
    // Previously one request at a time; a long page then took N round trips.
    return mapConcurrent(texts, MAX_SEGMENT_CONCURRENCY, text => googleOne(text, target));
  }
};

const mymemory = {
  id: 'mymemory',
  translate({ texts, source, target }) {
    const sourceLang = mymemoryLang(source);
    // MyMemory's free tier rate-limits aggressively, so keep a low fan-out and
    // the inter-request pause, but still overlap two segments at a time.
    return mapConcurrent(texts, 2, async text => {
      const url =
        'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(text.slice(0, 500)) +
        '&langpair=' +
        encodeURIComponent(sourceLang) +
        '%7C' +
        encodeURIComponent(target);
      const data = await http(url);
      if (data?.responseStatus !== 200) throw new Error(data?.responseDetails || 'MyMemory 服务不可用');
      const value = data.responseData.translatedText;
      await sleep(120);
      return value;
    });
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

// ---------------------------------------------------------------- DeepLX / DLX
//
// DeepLX (renamed "DLX" upstream in 2026) is an unofficial, self-hosted DeepL
// bridge. POST /translate accepts an array of strings and returns a
// position-aligned array in `data`, but the anonymous oneshot channel caps the
// *whole request* at 1500 UTF-16 characters and answers HTTP 413 above that.
// Chunk by total length here so a long page never trips the cap.

const DEEPLX_MAX_CHARS = 1400;

function deeplxEndpoint(value) {
  const base = trimSlash(String(value || '').trim()) || 'http://localhost:1188';
  // Accept either a bare instance URL or a full /translate (or /v1/translate)
  // endpoint, which is what most DeepLX setup guides tell people to paste.
  return /\/(?:v\d+\/)?translate$/i.test(base) ? base : `${base}/translate`;
}

// Split an oversized paragraph on sentence boundaries, keeping the trailing
// punctuation/line break so the translated pieces can be joined back without
// swallowing separators.
function deeplxPieces(text, limit = DEEPLX_MAX_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return [value];
  const sentences = value.match(/[^.!?。！？；;\n]+(?:[.!?。！？；;\n]+|$)|[.!?。！？；;\n]+/gu) || [value];
  const pieces = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current) { pieces.push(current); current = ''; }
      for (let i = 0; i < sentence.length; i += limit) pieces.push(sentence.slice(i, i + limit));
      continue;
    }
    if (current && current.length + sentence.length > limit) { pieces.push(current); current = ''; }
    current += sentence;
  }
  if (current) pieces.push(current);
  return pieces;
}

async function deeplxRequest(chunks, config, target) {
  const headers = { 'Content-Type': 'application/json' };
  const token = String(config.token || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const data = await http(deeplxEndpoint(config.url), {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: chunks, source_lang: 'auto', target_lang: deeplLang(target) })
  });
  if (data?.code && Number(data.code) !== 200) {
    throw new Error(`DeepLX 返回错误码 ${data.code}：${data.message || '未知错误'}`);
  }
  const raw = data?.data;
  // Current DLX answers with `data` as a string or an array; some older forks
  // wrap a single result in { result }.
  const values = Array.isArray(raw) ? raw
    : typeof raw === 'string' ? [raw]
      : chunks.length === 1 && typeof raw?.result === 'string' ? [raw.result]
        : null;
  if (!values || values.length !== chunks.length) throw new Error('DeepLX 返回的译文数量不匹配');
  return values.map(value => String(value ?? ''));
}

const deeplx = {
  id: 'deeplx',
  async translate({ texts, target, config }) {
    const groups = texts.map(text => deeplxPieces(text));
    const flat = groups.flat();
    if (!flat.length) return [];
    const batches = [];
    let current = [];
    let chars = 0;
    for (const chunk of flat) {
      if (current.length && chars + chunk.length > DEEPLX_MAX_CHARS) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(chunk);
      chars += chunk.length;
    }
    if (current.length) batches.push(current);
    // Self-hosted instances are usually single-process; keep fan-out low.
    const translated = (await mapConcurrent(batches, 2, batch => deeplxRequest(batch, config, target))).flat();
    if (translated.length !== flat.length) throw new Error('DeepLX 返回的译文数量不匹配');
    let cursor = 0;
    return groups.map(pieces => {
      const value = translated.slice(cursor, cursor + pieces.length).join('');
      cursor += pieces.length;
      return value;
    });
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
  const run = credentials =>
    mapConcurrent(texts, MAX_SEGMENT_CONCURRENCY, text => bingTranslateOne(text, to, credentials));
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
    const extensionUrl = typeof chrome !== 'undefined' ? chrome.runtime?.getURL?.('') : '';
    if (!extensionUrl.startsWith('safari-web-extension:')) {
      throw new Error('系统翻译仅支持 iOS / macOS 上的 Safari 扩展，请切换到 Google 或 Microsoft 翻译');
    }
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

function isSafariExtension() {
  const url = typeof chrome !== 'undefined' ? chrome.runtime?.getURL?.('') : '';
  return String(url).startsWith('safari-web-extension:');
}

function autoEngineIds(settings = {}) {
  const configured = settings.engines || {};
  const ids = ['google', 'mymemory', 'indextranslate'];
  if (!configured.microsoft?.useKey || String(configured.microsoft.key || '').trim()) ids.push('microsoft');
  if (isSafariExtension()) ids.push('apple');
  if (String(configured.deepl?.key || '').trim()) ids.push('deepl');
  // Only join the race when an instance was actually configured; otherwise
  // every user would fire a guaranteed-to-fail request at localhost:1188.
  if (String(configured.deeplx?.url || '').trim()) ids.push('deeplx');
  if (String(configured.libre?.url || '').trim()) ids.push('libre');
  for (const id of ['openai', 'deepseek', 'gemini', 'claude']) {
    if (String(configured[id]?.apiKey || '').trim()) ids.push(id);
  }
  if (String(configured.custom?.baseUrl || '').trim()) ids.push('custom');
  return [...new Set(ids)];
}

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
  const promptOf = list => buildPrompt({ texts: list, source, target, config });
  if (texts.length === 1) return [cleanSingle(await ask(promptOf(texts)))];
  const parsed = parseNumbered(await ask(promptOf(texts)), texts.length);
  if (parsed) {
    // Keep every good segment; only re-request the empty slots instead of
    // discarding the whole batch (FluentRead: partial repair, not full replay).
    const missing = parsed.map((value, index) => (value ? -1 : index)).filter(index => index >= 0);
    if (!missing.length) return parsed;
    const repaired = await mapConcurrent(missing, 3, index =>
      ask(promptOf([texts[index]])).then(cleanSingle));
    missing.forEach((index, position) => { parsed[index] = repaired[position]; });
    return parsed;
  }
  // The model ignored the numbering contract. Retry per segment concurrently —
  // N sequential retries multiplied latency and all but guaranteed a timeout.
  return mapConcurrent(texts, 3, text => ask(promptOf([text])).then(cleanSingle));
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

// Index-Translate (Bilibili) is an OpenAI-compatible chat-completions endpoint
// with a free, keyless public API. It is a translation-specialised model rather
// than a general LLM, so it gets its own entry with sensible defaults instead of
// forcing users through the generic "custom" form. The API key is optional
// (any string or empty is accepted), and the online + self-hosted vLLM base
// URLs and the flagship model are pre-filled when the user leaves them blank.
const indextranslate = {
  id: 'indextranslate',
  translate({ texts, source, target, config }) {
    const merged = { ...config, allowAnonymous: true };
    if (!trimSlash(merged.baseUrl)) merged.baseUrl = 'https://index-translate.bilibili.com/v1';
    if (!merged.model) merged.model = 'Index-Translate-35B-A3B';
    return openAiChat({ texts, source, target, config: merged });
  }
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

function parseVisionResult(raw, { allowPlainText = false } = {}) {
  let text = String(raw || '').trim();
  // Reasoning models occasionally prepend a <think> block to the answer.
  text = text.replace(/^\s*<think\b[^>]*>[\s\S]*?<\/think>\s*/i, '');
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1].trim();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Index-Translate is a translation-specialised model: on some images it
    // returns a plain translated sentence instead of the requested box array.
    // Show that over the whole image rather than failing the entire panel.
    if (allowPlainText && text) return [{ box: [0, 0, 1, 1], text: '', translation: text }];
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

const VISION_LABEL = {
  indextranslate: 'Index 翻译',
  openai: 'OpenAI',
  gemini: 'Gemini',
  claude: 'Claude'
};

export async function visionOcrTranslate({ engine, image, source = 'auto', target, config = {} }) {
  if (!VISION_ENGINES.includes(engine)) {
    throw new Error(`该引擎不支持视觉翻译，请选择：${VISION_ENGINES.map(id => VISION_LABEL[id] || id).join(' / ')}`);
  }
  let merged = config;
  if (engine === 'indextranslate') {
    // Same keyless OpenAI-compatible endpoint as text translation, but the
    // vision caller needs its own defaults (its fallback model is gpt-4o-mini).
    merged = { ...config, allowAnonymous: true };
    if (!trimSlash(merged.baseUrl)) merged.baseUrl = 'https://index-translate.bilibili.com/v1';
    if (!merged.model) merged.model = 'Index-Translate-35B-A3B';
  }
  const caller = engine === 'gemini' ? visionGemini : engine === 'claude' ? visionClaude : visionOpenAi;
  const raw = await caller({ image, prompt: visionUserPrompt(target), config: merged });
  return parseVisionResult(raw, { allowPlainText: engine === 'indextranslate' });
}

// ---------------------------------------------------------------- registry

export const PROVIDERS = { google, mymemory, deepl, deeplx, microsoft, libre, apple, openai, deepseek, gemini, claude, custom, indextranslate };

export function hasProvider(id) {
  return Boolean(PROVIDERS[id]);
}

// Default OpenAI-compatible base URLs when the user leaves the field blank.
const MODEL_BASE = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  indextranslate: 'https://index-translate.bilibili.com/v1'
};

/**
 * Discover the models a configured AI endpoint actually exposes. The settings
 * page uses this to validate an address/key and to offer clickable model ids,
 * which doubles as a connectivity check (and surfaces the B站 WAF 412 hint).
 * Returns a de-duplicated list of ids in the server's own order.
 */
export async function detectModels({ engine, config = {} }) {
  const apiKey = String(config.apiKey || '').trim();
  let url;
  let headers = {};
  if (engine === 'gemini') {
    if (!apiKey) throw new Error('请先填写 Gemini API Key');
    url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
  } else if (engine === 'claude') {
    if (!apiKey) throw new Error('请先填写 Anthropic API Key');
    url = 'https://api.anthropic.com/v1/models?limit=200';
    headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
  } else {
    const base = trimSlash(config.baseUrl) || MODEL_BASE[engine];
    if (!base) throw new Error('请先填写接口地址');
    url = `${base}/models`;
    // The free public Index-Translate API is keyless but still expects *some*
    // Bearer value from OpenAI-compatible clients.
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    else if (engine === 'indextranslate') headers.Authorization = 'Bearer index';
  }
  const data = await http(url, { headers }, 15000);
  const rows = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
      : Array.isArray(data) ? data : [];
  const ids = rows
    .map(row => (typeof row === 'string' ? row : row?.id || row?.name || ''))
    .filter(Boolean)
    .map(id => String(id).replace(/^models\//, ''));
  const models = [...new Set(ids)];
  if (!models.length) throw new Error('该接口未返回可用模型，请检查地址与密钥');
  return models;
}

export async function translateTexts({ engine, texts, source = 'auto', target, config = {} }) {
  if (engine === 'auto') {
    const settings = config.settings || {};
    const ids = autoEngineIds(settings);
    const attempts = ids.map(id => translateTexts({
      engine: id,
      texts,
      source,
      target,
      config: settings.engines?.[id] || {}
    }).then(result => {
      // In racing mode a partially empty result must not beat an engine that
      // actually translated everything.
      if (result.some(value => !value)) throw new Error('引擎返回不完整译文');
      return { result, id };
    }));
    if (!attempts.length) throw new Error('没有可用的翻译引擎');
    try {
      return (await Promise.any(attempts)).result;
    } catch {
      throw new Error('所有可用翻译引擎均翻译失败');
    }
  }
  const provider = PROVIDERS[engine];
  if (!provider) throw new Error(`未知的翻译引擎：${engine}`);
  if (!Array.isArray(texts) || !texts.length) return [];
  // Isolate failures per sub-batch: one slow/failed request must not discard
  // translations that already succeeded elsewhere on the same page.
  const runBatch = async batch => {
    try {
      const output = await provider.translate({ texts: batch, source, target, config });
      return { ok: true, values: batch.map((_, index) => String(output[index] ?? '')) };
    } catch (error) {
      return { ok: false, error, size: batch.length };
    }
  };
  const batches = splitBatches(texts);
  const groups = batches.length === 1
    ? [await runBatch(batches[0])]
    : await mapConcurrent(batches, MAX_BATCH_CONCURRENCY, runBatch);
  // Surface a real error (bad key, network down) only when nothing worked.
  // Otherwise return empty strings for the failed slots; the cache layer skips
  // falsy values, so incomplete results are never cached.
  if (groups.every(group => !group.ok)) throw groups[0]?.error || new Error('翻译失败');
  return groups.flatMap(group => group.ok ? group.values : Array(group.size).fill(''));
}
