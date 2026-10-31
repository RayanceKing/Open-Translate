import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../extension/lib/defaults.js';

let settings = {};
let listener;
let handler;
const calls = [];
globalThis.chrome = {
  storage: { local: { get: async () => ({ settings }) } },
  runtime: { onMessage: { addListener: fn => { listener = fn; } }, onInstalled: { addListener() {} } },
  contextMenus: { onClicked: { addListener() {} } }
};
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  const data = await handler(String(url), options);
  return { ok: true, status: 200, text: async () => JSON.stringify(data) };
};
await import('../extension/background.js');
const message = data => new Promise(resolve => listener(data, {}, resolve));
const translate = texts => message({ type: 'translate', texts });
const clear = async () => { await message({ type: 'clear-cache' }); calls.length = 0; };
const google = text => [[[text]]];
const aiResponse = (engine, content) => engine === 'gemini' ? { candidates: [{ content: { parts: [{ text: content }] } }] } : engine === 'claude' ? { content: [{ type: 'text', text: content }] } : { choices: [{ message: { content } }] };
const promptOf = (engine, body) => engine === 'gememini' ? body.contents[0].parts[0].text : engine === 'gemini' ? body.contents[0].parts[0].text : body.messages.at(-1).content;

test('legacy and imported settings normalize without overriding explicit empty custom terms', () => {
  assert.equal(normalizeSettings({ai:{glossary:'foo = bar'}}).glossary.customTerms, 'foo = bar');
  assert.equal(normalizeSettings({ai:{glossary:'foo = bar'}, glossary:{customTerms:''}}).glossary.customTerms, '');
  assert.deepEqual(normalizeSettings({glossary:{libraryIds:['programming','programming',4]}}).glossary.libraryIds, ['programming']);
});

test('all AI providers filter glossary per batch and per-segment fallback, after privacy masking', async () => {
  for (const engine of ['openai','deepseek','gemini','claude']) {
    await clear();
    settings = {engine, engines:{[engine]:{apiKey:'key'}}, glossary:{customTerms:'cat = 猫\ndog = 狗\nunseen = 隐藏'}};
    handler = async () => aiResponse(engine, calls.length === 1 ? 'unnumbered' : 'translated');
    assert.deepEqual(await translate(['cat contact me@example.com','dog']), {texts:['translated','translated']});
    assert.equal(calls.length, 3);
    const prompts = calls.map(c => promptOf(engine, JSON.parse(c.options.body)));
    assert.match(prompts[0], /猫/); assert.match(prompts[0], /狗/); assert.doesNotMatch(prompts[0], /隐藏|me@example\.com/);
    assert.match(prompts[1], /猫/); assert.doesNotMatch(prompts[1], /狗|me@example\.com/);
    assert.match(prompts[2], /狗/); assert.doesNotMatch(prompts[2], /猫/);
  }
});

test('MT valid markers restore, damaged and duplicate markers retry without caching', async () => {
  for (const mode of ['valid','damaged','duplicate']) {
    await clear(); settings = {engine:'google', glossary:{machineTranslation:true,customTerms:'cat = 猫'}};
    handler = async url => {
      const q = new URL(url).searchParams.get('q');
      if (!q.includes('__OT_GLOSSARY_')) return google('fallback');
      return google(mode === 'valid' ? q : mode === 'damaged' ? q.replace('__OT_GLOSSARY_', '__OT_DAMAGED_') : q + q);
    };
    const expected = mode === 'valid' ? '猫' : 'fallback';
    assert.deepEqual(await translate(['cat']), {texts:[expected]});
    assert.deepEqual(await translate(['cat']), {texts:[expected]});
    assert.equal(calls.length, mode === 'valid' ? 1 : 4);
  }
});

test('disabled MT ignores malformed terms and does not make duplicate provider calls', async () => {
  await clear(); settings = {engine:'google',glossary:{machineTranslation:false,customTerms:'"broken'}};
  handler = async url => google(new URL(url).searchParams.get('q'));
  assert.deepEqual(await translate(['plain text']), {texts:['plain text']});
  assert.equal(calls.length,1);
});

test('glossary change alters cache salt and test-engine bypasses cache', async () => {
  await clear(); settings = {engine:'google', glossary:{machineTranslation:true,customTerms:'cat = 猫'}};
  handler = async url => google(new URL(url).searchParams.get('q'));
  assert.deepEqual(await translate(['cat']), {texts:['猫']});
  settings.glossary.customTerms = 'cat = 貓';
  assert.deepEqual(await translate(['cat']), {texts:['貓']});
  assert.equal(calls.length,2);
  assert.ok((await message({type:'test-engine'})).text);
  assert.ok((await message({type:'test-engine'})).text);
  assert.equal(calls.length,4);
});
