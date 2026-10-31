import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../tampermonkey/open-translate.user.js', import.meta.url), 'utf8');
const cut = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
function harness(settings, handler) {
  const requests = [];
  const context = vm.createContext({ structuredClone, URLSearchParams, setTimeout, console, settings, AI_ENGINES: ['openai', 'deepseek', 'gemini', 'claude'], GLOSSARY_LIBRARIES: [], GLOSSARY_SOURCE: {revision:'test'}, DEFAULT_PROMPT: 'translate to {{target}}', LANG_LABEL: {'zh-CN':'Chinese'}, sessionStorage: {getItem(){return null}, setItem(){}, removeItem(){}}, GM_xmlhttpRequest(options) { requests.push(options); handler(options, requests.length); } });
  vm.runInContext(`${cut('function glossaryCsvRows', '// END GENERATED GLOSSARY CORE')}
${cut('  function maskAll(', '  // ---------------------------------------------------------------- transport')}
${cut('  function http(', '  // ---------------------------------------------------------------- subtitles')}
globalThis.api = { requestTranslation, normalizeGlossarySettings, buildPrompt, cacheKeyFor };`, context);
  return { api: context.api, requests, settings };
}
const config = (engine = 'openai') => ({ engine, targetLanguage:'zh-CN', ai:{prompt:'translate {{target}}', temperature:0.2, glossary:''}, glossary:{enabled:true,machineTranslation:false,libraryIds:[],customTerms:'apple = 苹果\npear = 梨',customTargetLanguage:'*'}, privacy:{maskSensitive:true}, engines:{openai:{apiKey:'key',model:'test'},google:{}} });
const respond = (options, payload) => options.onload({status:200,responseText:JSON.stringify(payload)});

test('AI batch fallback uses only matching terms and masks private data', async () => {
  const {api,requests} = harness(config(), (o,n) => respond(o, {choices:[{message:{content:n === 1 ? 'invalid' : n === 2 ? '苹果 __OT_PRIVATE_0__' : '梨'}}]}));
  const result = await api.requestTranslation(['apple x@example.com','pear']);
  assert.deepEqual(Array.from(result), ['苹果 x@example.com','梨']);
  const prompts = requests.map(r => JSON.parse(r.data).messages[1].content);
  assert.equal(prompts.length, 3);
  assert.ok(!prompts.join('\n').includes('x@example.com'));
  assert.match(prompts[1], /apple/); assert.doesNotMatch(prompts[1], /pear/);
  assert.match(prompts[2], /pear/); assert.doesNotMatch(prompts[2], /apple/);
});

test('damaged machine-translation placeholder retries without caching fallback', async () => {
  const cfg = config('google'); cfg.glossary.machineTranslation = true;
  const {api,requests} = harness(cfg, (o,n) => respond(o, [[[(n % 2 ? 'damaged' : 'ordinary')]]]));
  assert.deepEqual(Array.from(await api.requestTranslation(['apple'])), ['ordinary']);
  assert.deepEqual(Array.from(await api.requestTranslation(['apple'])), ['ordinary']);
  assert.equal(requests.length, 4);
});

test('legacy unstructured glossary does not break machine translation', async () => {
  const cfg = config('google'); cfg.glossary = undefined; cfg.ai.glossary = 'Always translate Apple as 苹果.';
  // loadSettings normalizes legacy fields before requests are sent.
  const h = harness(cfg, o => respond(o, [[['译文']]]));
  cfg.glossary = h.api.normalizeGlossarySettings(undefined, cfg.ai.glossary, cfg.targetLanguage);
  assert.deepEqual(Array.from(await h.api.requestTranslation(['hello'])), ['译文']);
});
