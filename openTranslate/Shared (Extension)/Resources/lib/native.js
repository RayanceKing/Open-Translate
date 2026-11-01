// Bridge to the native Safari app extension (SafariWebExtensionHandler).
//
// In a Safari Web Extension only the background service worker is allowed to call
// runtime.sendNativeMessage directly. Content scripts and the options page must
// route through the background, which forwards the call and returns the reply.
// The native handler lives in Swift and talks to the system Keychain and iCloud.

const NATIVE_APP = 'com.stuwang.openTranslate.Extension';
const NATIVE_TIMEOUT = 25000;

// For the background worker itself: talk to the native component directly.
export function nativeSend(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('与系统原生组件通信超时'));
    }, NATIVE_TIMEOUT);
    const done = response => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lastError = chrome.runtime.lastError;
      if (lastError) { reject(new Error(lastError.message || '调用原生组件失败')); return; }
      if (response && response.error) { reject(new Error(response.error)); return; }
      resolve(response || {});
    };
    try {
      const pending = chrome.runtime.sendNativeMessage(NATIVE_APP, message, done);
      if (pending && typeof pending.then === 'function') pending.then(done, reject);
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
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
