import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser, waitUntil } from './helpers/browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const browser = await launchBrowser(resolve(root, 'extension'));
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html lang="en"><head><title>Glossary smoke</title></head><body><article><h1>Database glossary test</h1><p id="article">The Database stores information for this programming tutorial and keeps the records available.</p></article></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const screenshots = [];
const click = (page, selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function fill(page, selector, value, event = 'input') {
  await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles:true})); })()`);
}

try {
  const workerTarget = await waitUntil(async () => (await browser.send('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/background.js')), 'extension worker');
  const worker = await browser.attach(workerTarget.targetId);
  // All provider traffic is simulated inside the isolated test worker. No API key
  // or selected web content leaves the browser during this smoke run.
  await worker.evaluate(`globalThis.__requests = []; globalThis.fetch = async (url, options = {}) => {
    __requests.push({url:String(url),body:options.body});
    if (String(url).includes('translate.googleapis.com')) {
      const text = new URL(url).searchParams.get('q');
      const translated = globalThis.__damage ? text.replace(/__OT_GLOSSARY_[A-Za-z0-9_]+__/g, '') : text;
      return new Response(JSON.stringify([[[translated, text, null, null]]]), {status:200});
    }
    if (String(url).includes('/chat/completions')) {
      const prompt = JSON.parse(options.body).messages.at(-1).content;
      const count = /contains (\\d+) segments/.exec(prompt)?.[1];
      const content = count ? Array.from({length:Number(count)}, (_,i) => (i+1)+'. 模拟 AI 译文').join('\\n') : '模拟 AI 译文';
      return new Response(JSON.stringify({choices:[{message:{content}}]}), {status:200});
    }
    throw new Error('Unexpected network request: '+url);
  }`);
  const extensionOrigin = new URL(workerTarget.url).origin;
  // URL.origin is null for chrome-extension schemes in Node; keep the host.
  const base = workerTarget.url.replace(/background\.js$/, '');
  const options = await browser.page(base + 'options.html');
  await waitUntil(() => options.evaluate('Boolean(document.querySelector("#glossary-custom")) && document.querySelectorAll("#glossary-libraries input").length'), 'glossary options');
  assert.equal(await options.evaluate('document.querySelectorAll("#glossary-libraries input").length'), 36);
  assert.equal(await options.evaluate('document.querySelector("[data-path=\\"glossary.machineTranslation\\"]").checked'), false, 'machine glossary is opt-in');
  await click(options, '[data-target="glossary"]');
  await fill(options, '#glossary-search', 'programming');
  // Catalog search may use the Chinese title; the stable ID must be searchable.
  assert.ok(await options.evaluate('document.querySelectorAll("#glossary-libraries input").length') > 0, 'library IDs are searchable');
  await fill(options, '#glossary-search', '');
  await fill(options, '#glossary-custom', 'Database = 自定义数据库');
  await click(options, '[data-path="glossary.machineTranslation"]');
  await waitUntil(() => options.evaluate('chrome.storage.local.get("settings").then(v => v.settings?.glossary?.customTerms === "Database = 自定义数据库" && v.settings.glossary.machineTranslation)'), 'saved glossary');
  const result = await options.evaluate('chrome.runtime.sendMessage({type:"translate",texts:["Database stores information."]})');
  assert.deepEqual(result.texts, ['自定义数据库 stores information.']);
  assert.ok((await worker.evaluate('globalThis.__requests.at(-1).url')).includes('OT_GLOSSARY'), 'MT sends protected terms');
  screenshots.push(await options.screenshot('extension-glossary'));
  await options.send('Page.reload');
  await waitUntil(() => options.evaluate('document.querySelector("#glossary-custom")?.value === "Database = 自定义数据库"'), 'glossary persistence');
  await fill(options, '#glossary-custom', 'invalid line');
  await waitUntil(() => options.evaluate('document.querySelector("#glossary-error").textContent'), 'invalid input error');
  assert.equal(await options.evaluate('chrome.storage.local.get("settings").then(v => v.settings.glossary.customTerms)'), 'Database = 自定义数据库');
  await fill(options, '#glossary-custom', 'Database = 自定义数据库');

  // Exercise the real content script's page and selection entrypoints.
  const article = await browser.page(url + '/extension');
  await waitUntil(() => article.evaluate('Boolean(document.querySelector("#article"))'), 'article');
  await options.evaluate(`chrome.tabs.query({}).then(tabs => chrome.tabs.sendMessage(tabs.find(t => t.url === ${JSON.stringify(url + '/extension')}).id, {type:'toggle'}))`);
  await waitUntil(() => article.evaluate('Array.from(document.querySelectorAll(".ot-translation")).some(n => n.textContent.includes("自定义数据库"))'), 'extension page translation');
  screenshots.push(await article.screenshot('extension-article'));

  // Confirm AI request contains matched terms, rather than MT placeholders or an
  // entire selected library. API traffic remains mocked by the worker above.
  await options.evaluate(`chrome.storage.local.get('settings').then(({settings:s}) => { s.engine='openai'; s.engines.openai.apiKey='local-smoke-only'; s.glossary.customTerms='Database = 自定义数据库\\nUnused = 不应发送'; return chrome.storage.local.set({settings:s}); })`);
  const ai = await options.evaluate('chrome.runtime.sendMessage({type:"translate",texts:["Database stores information."]})');
  assert.deepEqual(ai.texts, ['模拟 AI 译文']);
  const body = await worker.evaluate('globalThis.__requests.at(-1).body');
  assert.ok(body.includes('自定义数据库'));
  assert.ok(!body.includes('不应发送'));
  assert.ok(!body.includes('__OT_GLOSSARY_'));
  await options.evaluate("chrome.storage.local.get('settings').then(({settings:s}) => { s.engine='openai'; s.engines.openai.apiKey='local-smoke-only'; return chrome.storage.local.set({settings:s}); })");
  await click(options, '[data-library="web3"]');
  await waitUntil(() => options.evaluate('chrome.storage.local.get("settings").then(v => v.settings.glossary.libraryIds.includes("web3"))'), 'selected built-in library');
  await options.evaluate("chrome.storage.local.get('settings').then(({settings:s}) => { s.engine='openai'; s.engines.openai.apiKey='local-smoke-only'; return chrome.storage.local.set({settings:s}); })");
  const web3Result = await options.evaluate('chrome.runtime.sendMessage({type:"translate",texts:["Blockchain uses a Cryptocurrency protocol."]})');
  assert.deepEqual(web3Result.texts, ['模拟 AI 译文']);
  const web3Body = await worker.evaluate('globalThis.__requests.map(item => item.body).find(body => body?.includes("Blockchain"))');
  assert.ok(web3Body.includes('区块链'), `AI prompt should include matched built-in target: ${web3Body}`);
  assert.ok(web3Body.includes('加密货币'));
  assert.ok(!web3Body.includes('所有语言'));

  // A damaged marker retries as plain text and must never be cached as a
  // glossary-success result. Both requests are intercepted in the worker.
  // Stop the page translation before switching engines so its settings listener
  // cannot add unrelated requests to the fallback request count.
  await options.evaluate(`chrome.tabs.query({}).then(tabs => chrome.tabs.sendMessage(tabs.find(t => t.url === ${JSON.stringify(url + '/extension')}).id, {type:'restore'}))`);
  await worker.evaluate('globalThis.__damage = true');
  await options.evaluate("chrome.storage.local.get('settings').then(({settings:s}) => { s.engine='google'; return chrome.storage.local.set({settings:s}); })");
  const beforeDamage = await worker.evaluate('globalThis.__requests.length');
  const damagedInput = 'Database damage fallback must remain readable.';
  const damaged = await options.evaluate(`chrome.runtime.sendMessage({type:"translate",texts:[${JSON.stringify(damagedInput)}]})`);
  assert.deepEqual(damaged.texts, [damagedInput]);
  assert.equal(await worker.evaluate('globalThis.__requests.length'), beforeDamage + 2, 'damaged marker uses a plain-text retry');
  const again = await options.evaluate(`chrome.runtime.sendMessage({type:"translate",texts:[${JSON.stringify(damagedInput)}]})`);
  assert.deepEqual(again.texts, [damagedInput]);
  assert.equal(await worker.evaluate('globalThis.__requests.length'), beforeDamage + 4, 'fallback result was not cached as a glossary translation');
  await worker.evaluate('globalThis.__damage = false');

  const privateText = 'Contact glossary-test@example.invalid about the Database term.';
  const privateResult = await options.evaluate(`chrome.runtime.sendMessage({type:"translate",texts:[${JSON.stringify(privateText)}]})`);
  assert.deepEqual(privateResult.texts, ['Contact glossary-test@example.invalid about the 自定义数据库 term.'], 'privacy placeholders are restored after MT');
  assert.ok(!(await worker.evaluate('globalThis.__requests.at(-1).url')).includes('glossary-test@example.invalid'), 'private data is masked before translation');

  // Use a separate browser without the extension for the single-file userscript.
  const scriptBrowser = await launchBrowser();
  try {
    const page = await scriptBrowser.page(url + '/userscript');
    await waitUntil(() => page.evaluate('Boolean(document.querySelector("#article"))'), 'userscript fixture');
    await page.evaluate(`window.__gmStore = {}; window.__gmMenus = {}; window.__gmRequests=[];
      window.GM_getValue = (key, fallback) => __gmStore[key] ?? fallback;
      window.GM_setValue = (key, value) => { __gmStore[key] = structuredClone(value); };
      window.GM_registerMenuCommand = (label, action) => { __gmMenus[label] = action; };
      window.GM_xmlhttpRequest = options => {
        __gmRequests.push(options.url);
        if (!options.url.includes('translate.googleapis.com')) throw new Error('Unexpected userscript network request');
        const text = new URL(options.url).searchParams.get('q');
        setTimeout(() => options.onload({status:200,responseText:JSON.stringify([[[text,text,null,null]]])}), 0);
        return {abort(){}};
      };`);
    await page.evaluate(await readFile(resolve(root, 'tampermonkey/open-translate.user.js'), 'utf8'));
    await page.evaluate('window.__gmMenus["Open Translate 设置"]()');
    // Settings live inside a shadow root.
    const shadow = `Array.from(document.querySelectorAll('*')).find(n => n.shadowRoot?.querySelector('[data-tab="glossary"]')).shadowRoot`;
    await waitUntil(() => page.evaluate(`Boolean(${shadow})`), 'userscript settings');
    await page.evaluate(`${shadow}.querySelector('[data-tab="glossary"]').click()`);
    assert.equal(await page.evaluate(`${shadow}.querySelectorAll('[data-library]').length`), 36);
    await page.evaluate(`(() => { const r = ${shadow}; const t = r.querySelector('[data-k="glossary.customTerms"]'); t.value='Database = 脚本数据库'; t.dispatchEvent(new Event('input',{bubbles:true})); r.querySelector('[data-k="glossary.machineTranslation"]').click(); })()`);
    await waitUntil(() => page.evaluate('__gmStore.settings?.glossary?.customTerms === "Database = 脚本数据库" && __gmStore.settings.glossary.machineTranslation'), 'userscript save');
    screenshots.push(await page.screenshot('userscript-glossary'));
    await page.evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",code:"Escape",bubbles:true})); document.dispatchEvent(new KeyboardEvent("keydown",{key:"t",code:"KeyT",altKey:true,bubbles:true}))');
    await waitUntil(() => page.evaluate('Array.from(document.querySelectorAll(".ot-translation")).some(n => n.textContent.includes("脚本数据库"))'), 'userscript page translation');
    screenshots.push(await page.screenshot('userscript-article'));
    const errors = scriptBrowser.events.filter(e => e.method === 'Runtime.exceptionThrown');
    assert.deepEqual(errors, [], 'userscript browser exceptions');
  } finally { await scriptBrowser.close(); }

  const errors = browser.events.filter(e => e.method === 'Runtime.exceptionThrown');
  assert.deepEqual(errors, [], 'extension browser exceptions');
  console.log(JSON.stringify({status:'passed',screenshots}, null, 2));
} finally {
  server.close();
  await browser.close();
}
