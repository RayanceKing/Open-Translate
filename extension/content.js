(() => {
  const MARK = 'data-open-translate', SKIP = 'script,style,noscript,textarea,input,select,option,button,code,pre,kbd,samp,svg,canvas,[contenteditable="true"],[data-open-translate]';
  const RULES = { 'github.com': ['article.markdown-body','.js-comment-body'], 'reddit.com': ['[data-testid="post-content"]','[id^="t3_"]'], 'news.ycombinator.com': ['.titleline','.commtext'] };
  let active = false, target = 'zh-CN', observer;
  const clean = s => s.replace(/\s+/g, ' ').trim();
  const send = text => new Promise(resolve => chrome.runtime.sendMessage({ type:'translate', text, target }, resolve));
  const roots = () => { const els = (RULES[location.hostname] || ['article','main','[role="main"]']).flatMap(s => [...document.querySelectorAll(s)]); return els.length ? els : [document.body]; };
  const blocks = root => [...root.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,td,th')].filter(el => !el.closest(SKIP) && !el.nextElementSibling?.hasAttribute(MARK) && clean(el.innerText || '').length > 2);
  async function one(el) { const node = document.createElement('div'); node.className = 'ot-translation'; node.setAttribute(MARK,'translation'); node.textContent = '翻译中…'; el.after(node); const result = await send(clean(el.innerText)); node.textContent = result?.text || `翻译失败：${result?.error || '未知错误'}`; if (result?.error) node.classList.add('ot-error'); }
  async function run(root) { if (!active) return; for (const el of blocks(root)) { if (!active) break; await one(el); await new Promise(r => setTimeout(r, 90)); } }
  function toggle() { active = !active; if (active) runAll(); else document.querySelectorAll(`[${MARK}]`).forEach(n => n.remove()); }
  function runAll() { roots().forEach(run); }
  chrome.storage.local.get({ targetLanguage:'zh-CN' }, data => { target = data.targetLanguage; });
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'toggle') toggle(); if (message.type === 'restore') { active = false; document.querySelectorAll(`[${MARK}]`).forEach(n => n.remove()); } if (message.type === 'translate') { target = message.target || target; active = true; runAll(); } });
  document.addEventListener('keydown', e => { if (e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); toggle(); } });
  observer = new MutationObserver(records => { if (active) records.forEach(r => r.addedNodes.forEach(n => { if (n.nodeType === 1 && !n.hasAttribute(MARK)) run(n); })); }); observer.observe(document.body, { childList:true, subtree:true });
})();
