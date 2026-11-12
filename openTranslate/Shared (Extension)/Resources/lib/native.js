// Bridge to the native Safari app extension (SafariWebExtensionHandler).
//
// In a Safari Web Extension only the background service worker is allowed to call
// runtime.sendNativeMessage directly. Content scripts and the options page must
// route through the background, which forwards the call and returns the reply.
// The native handler lives in Swift and talks to the system Keychain, iCloud and
// (see below) performs HTTP requests on behalf of the extension.

const NATIVE_APP = 'com.stuwang.openTranslate.Extension';
const NATIVE_TIMEOUT = 25000;
// Swift gives every relayed request 10s; leave 2s for the IPC round-trip.
export const NATIVE_HTTP_TIMEOUT = 12000;

// Only these headers cross the JS -> Swift boundary. Origin / Referer /
// User-Agent / Sec-Fetch-* are browser fingerprints and must never be forwarded;
// the native side builds its own, ordinary App headers.
const FORWARD_HEADERS = /^(content-type|authorization|accept|accept-language)$/i;

function sanitizeHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (FORWARD_HEADERS.test(name) && typeof value === 'string') out[name] = value;
  }
  return out;
}

function nativeError(message) {
  const error = new Error(message);
  error.otNative = true;
  error.status = 0;
  error.rawBody = '';
  error.data = null;
  return error;
}

// For the background worker itself: talk to the native component directly.
export function nativeSend(message, timeout = NATIVE_TIMEOUT, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(nativeError('与系统原生组件通信超时'));
    }, timeout);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const done = response => {
      if (settled) return;
      const lastError = chrome.runtime.lastError;
      if (lastError) { finish(reject, nativeError(lastError.message || '调用原生组件失败')); return; }
      // `raw` lets sendViaNativeApp see the full error reply (status + body)
      // instead of a flattened message. Secret/settings callers keep the
      // default behaviour: an `error` field rejects immediately.
      if (!options.raw && response && response.error) { finish(reject, nativeError(response.error)); return; }
      finish(resolve, response || {});
    };
    try {
      const pending = chrome.runtime.sendNativeMessage(NATIVE_APP, message, done);
      if (pending && typeof pending.then === 'function') {
        pending.then(done, error => finish(reject, nativeError(error?.message || '调用原生组件失败')));
      }
    } catch (error) {
      finish(reject, nativeError(error?.message || '调用原生组件失败'));
    }
  });
}

/**
 * Relay one HTTP request through the native app extension.
 *
 * The native process issues the request with URLSession, so it carries no
 * `Origin: safari-web-extension://…` header and is not blocked by B站's WAF.
 * iOS/iPadOS cannot push messages from the app to the extension — this is a
 * strict request/reply round-trip: the extension always calls first.
 *
 * @param {{url:string, method?:string, headers?:object, body?:string|null, timeout?:number}} payload
 * @returns {Promise<{status:number, data:any, raw:string}>}
 * @throws {Error} with `.otNative`, `.status`, `.rawBody`, `.data` on failure
 */
export async function sendViaNativeApp(payload) {
  if (!payload || typeof payload.url !== 'string' || !/^https?:\/\//i.test(payload.url)) {
    throw nativeError('原生转发缺少合法的请求地址');
  }
  const seconds = Math.min(30, Math.max(1, Number(payload.timeout) || 10));
  const message = {
    type: 'http',
    url: payload.url,
    method: String(payload.method || 'GET').toUpperCase(),
    headers: sanitizeHeaders(payload.headers),
    body: typeof payload.body === 'string' ? payload.body : null,
    timeout: seconds
  };

  const reply = await nativeSend(message, Math.max(NATIVE_HTTP_TIMEOUT, seconds * 1000 + 2000), { raw: true });
  if (!reply || typeof reply !== 'object') throw nativeError('原生组件返回了空响应');
  if (reply.error) {
    const error = nativeError(String(reply.error));
    error.status = Number(reply.status) || 0;
    error.rawBody = String(reply.body || '');
    error.data = reply.data ?? null;
    throw error;
  }
  if (!reply.ok) throw nativeError('原生组件未确认请求成功，请更新 App 后重试');
  return {
    status: Number(reply.status) || 200,
    data: reply.data ?? null,
    raw: String(reply.raw || '')
  };
}

// For content scripts / options page: ask the background to perform the native
// call. Safari's chrome shim returns results via callback, not a promise, so we
// wrap it explicitly.
export function requestNative(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'native', message }, response => {
        const lastError = chrome.runtime.lastError;
        if (lastError) { reject(new Error(lastError.message || '原生请求失败')); return; }
        if (response && response.error) { reject(new Error(response.error)); return; }
        resolve(response || {});
      });
    } catch (error) {
      reject(error);
    }
  });
}
