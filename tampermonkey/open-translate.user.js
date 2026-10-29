// ==UserScript==
// @name         Open Translate · Bilingual Web Reader
// @namespace    https://github.com/open-translate
// @version      0.1.0
// @description  In-place bilingual translation for readable web content. Option+T to toggle.
// @author       Open Translate contributors
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      translate.googleapis.com
// @connect      api.mymemory.translated.net
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const MARK = 'data-open-translate';
  const TARGET = GM_getValue('targetLanguage', 'zh-CN');
  const SITE_RULES = {
    'github.com': ['article.markdown-body', '.js-comment-body'],
    'reddit.com': ['[data-testid="post-content"]', '[id^="t3_"]'],
    'news.ycombinator.com': ['.titleline', '.commtext']
  };
  const SKIP = 'script,style,noscript,textarea,input,select,option,button,code,pre,kbd,samp,svg,canvas,[contenteditable="true"],[data-open-translate]';
  let target = TARGET, active = false, observer, translating = new WeakSet();

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = text => text.replace(/\s+/g, ' ').trim();
  function mask(text) {
    const values = [];
    const put = value => `__OT_PRIVATE_${values.push(value) - 1}__`;
    return {
      text: text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, put)
        .replace(/\b(?:\+?\d[\s-]?){8,16}\b/g, put)
        .replace(/\b(?:sk-[\w-]{16,}|ghp_[\w]{20,}|AKIA[\w]{16})\b/g, put),
      restore: result => result.replace(/__\s*OT_PRIVATE\s*_(\d+)\s*__/gi, (_, i) => values[Number(i)] || _)
    };
  }
  function request(text) {
    const protectedText = mask(text);
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(protectedText.text);
    const get = url => new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'GET', url, timeout: 15000, onload: r => r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error(`服务错误 (${r.status})`)), onerror: () => reject(new Error('无法连接翻译服务')), ontimeout: () => reject(new Error('翻译请求超时')) }));
    return get(url).then(raw => protectedText.restore(JSON.parse(raw)[0].map(x => x[0]).join(''))).catch(async () => {
      // Public Google endpoints are occasionally rate-limited; MyMemory is a direct, no-key fallback.
      const raw = await get('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(protectedText.text.slice(0, 500)) + '&langpair=auto%7C' + encodeURIComponent(target));
      const result = JSON.parse(raw); if (result.responseStatus !== 200) throw new Error(result.responseDetails || '翻译服务不可用');
      return protectedText.restore(result.responseData.translatedText);
    });
  }
  function contentRoots() {
    const selectors = SITE_RULES[location.hostname] || ['article', 'main', '[role="main"]'];
    const found = selectors.flatMap(s => [...document.querySelectorAll(s)]);
    return found.length ? found : [document.body];
  }
  function blocks(root) {
    return [...root.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,td,th')]
      .filter(el => !el.closest(SKIP) && !el.querySelector(`[${MARK}]`) && clean(el.innerText || '').length >= 3)
      .filter(el => { const parent = el.parentElement; return !parent || !(parent.matches('p,li,blockquote') && clean(parent.innerText).length > clean(el.innerText).length * 1.4); });
  }
  async function translateBlock(el) {
    if (translating.has(el) || el.nextElementSibling?.hasAttribute(MARK)) return;
    const source = clean(el.innerText || ''); if (!source) return;
    translating.add(el);
    const node = document.createElement('div'); node.setAttribute(MARK, 'translation'); node.className = 'ot-translation';
    node.textContent = '翻译中…'; el.insertAdjacentElement('afterend', node);
    try { node.textContent = await request(source); } catch (error) { node.textContent = `翻译失败：${error.message}`; node.classList.add('ot-error'); }
    finally { translating.delete(el); }
  }
  async function translate(root = null) {
    active = true; renderPanel(); const items = root ? blocks(root) : contentRoots().flatMap(blocks);
    for (const el of items) { if (!active) break; await translateBlock(el); await sleep(90); }
  }
  function restore() { active = false; document.querySelectorAll(`[${MARK}]`).forEach(n => n.remove()); renderPanel(); }
  function observe() {
    observer?.disconnect(); observer = new MutationObserver(records => { if (!active) return; for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && !n.hasAttribute(MARK)) translate(n); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function renderPanel() {
    let panel = document.getElementById('ot-panel');
    if (!panel) { panel = document.createElement('aside'); panel.id = 'ot-panel'; panel.innerHTML = '<button class="ot-main"></button><button class="ot-lang" title="修改目标语言"></button><button class="ot-close" title="还原页面">还原</button>'; document.body.append(panel);
      panel.querySelector('.ot-main').onclick = () => active ? restore() : translate();
      panel.querySelector('.ot-close').onclick = restore;
      panel.querySelector('.ot-lang').onclick = () => { const next = prompt('目标语言代码（例如 zh-CN、en、ja）：', target); if (next?.trim()) { target = next.trim(); GM_setValue('targetLanguage', target); if (active) { restore(); translate(); } renderPanel(); } };
    }
    panel.querySelector('.ot-main').textContent = active ? '翻译中' : '译'; panel.querySelector('.ot-lang').textContent = target; panel.querySelector('.ot-close').style.display = active ? 'block' : 'none';
  }
  function addStyle() { const style = document.createElement('style'); style.textContent = `.ot-translation{margin:.35em 0 1em;padding:.45em .7em;border-left:3px solid #6d5dfc;background:rgba(109,93,252,.08);color:inherit;font:inherit;line-height:1.65;opacity:.9}.ot-error{border-color:#d33;color:#b42318}#ot-panel{position:fixed;z-index:2147483647;right:18px;bottom:18px;display:flex;gap:5px;align-items:center;padding:6px;border-radius:12px;background:#171720;color:#fff;box-shadow:0 5px 22px #0004;font:13px -apple-system,BlinkMacSystemFont,sans-serif}#ot-panel button{border:0;border-radius:8px;padding:7px 9px;background:#302e42;color:#fff;cursor:pointer}#ot-panel .ot-main{background:#6d5dfc;font-weight:700}`; document.documentElement.append(style); }
  document.addEventListener('keydown', e => { if (e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); if (e.shiftKey) { const text = clean(getSelection()?.toString() || ''); if (text) request(text).then(result => alert(result)); } else active ? restore() : translate(); } });
  addStyle(); renderPanel(); observe();
})();
