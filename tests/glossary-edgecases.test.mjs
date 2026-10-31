import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCustomTerms, protectGlossary, matchGlossary, glossarySalt } from '../extension/lib/glossary.js';
import { GLOSSARY_SOURCE, GLOSSARY_LIBRARIES } from '../extension/lib/glossary-data.js';

test('equals syntax keeps commas and quotation marks in translations', () => {
  assert.deepEqual(parseCustomTerms('hello = 你好,世界\nquote = say "hello"'), [
    {source:'hello',target:'你好,世界',targetLanguage:'*'},
    {source:'quote',target:'say "hello"',targetLanguage:'*'}
  ]);
});

test('equals syntax keeps commas in translations', () => {
  assert.deepEqual(parseCustomTerms('hello = 你好,世界'), [{source:'hello',target:'你好,世界',targetLanguage:'*'}]);
});

test('targets containing another generated token are not recursively restored', () => {
  const old = Math.random;
  Math.random = () => 0.5;
  try {
    const p = protectGlossary(['one two'], [
      {source:'one',target:'__OT_GLOSSARY_ii_0_1__'}, {source:'two',target:'TWO'}
    ]);
    assert.deepEqual(p.restore(p.safe[0],0), {text:'__OT_GLOSSARY_ii_0_1__ TWO',valid:true});
  } finally { Math.random = old; }
});

test('placeholder collisions in input are skipped; validation checks count and segments', () => {
  const old = Math.random; let n = 0;
  Math.random = () => (++n <= 2 ? 0.5 : 0.25);
  try {
    const p = protectGlossary(['__OT_GLOSSARY_ii_0_0__ one', 'one'], [{source:'one',target:'1'}]);
    assert.match(p.safe[0], /__OT_GLOSSARY_99_0_0__/);
    assert.equal(p.restore(p.safe[0],0).valid,true);
    assert.equal(p.restore(p.safe[0] + p.safe[0],0).valid,false);
    assert.equal(p.restore(p.safe[1],0).valid,false);
  } finally { Math.random = old; }
});

test('CSV syntax, malformed input and Unicode boundaries', () => {
  assert.deepEqual(parseCustomTerms('source,target,tgt_lng\n"a,b","say ""hi""",zh-CN')[0], {source:'a,b',target:'say "hi"',targetLanguage:'zh-CN'});
  for (const bad of ['"bad', '"x"oops,y', 'a,b,c,d']) assert.throws(() => parseCustomTerms(bad));
  const entries = [{source:'cat',target:'猫'}, {source:'中文',target:'Chinese'}, {source:'PRIVATE',target:'secret'}];
  assert.deepEqual(matchGlossary(['écat cat 中文字 __OT_PRIVATE_0__'], entries), entries.slice(0,2));
});

test('salt scopes effective terms and engine mode', () => {
  const settings = {glossary:{customTerms:'foo,bar,zh-CN',machineTranslation:true}};
  assert.ok(glossarySalt(settings,'zh-CN',false));
  assert.equal(glossarySalt(settings,'ja',false),'');
  settings.glossary.machineTranslation = false;
  assert.equal(glossarySalt(settings,'zh-CN',false),'');
  assert.ok(glossarySalt(settings,'zh-CN',true));
});

test('userscript generated regions exactly match extension modules', async () => {
  const script = await readFile(new URL('../tampermonkey/open-translate.user.js', import.meta.url),'utf8');
  for (const [name,file] of [['DATA','glossary-data.js'],['CORE','glossary.js']]) {
    const source = await readFile(new URL('../extension/lib/' + file, import.meta.url),'utf8');
    const expected = source.replace(/^import\s+[^\n]+\n/gm,'').replace(/^export\s+/gm,'').trimEnd();
    const begin = `// BEGIN GENERATED GLOSSARY ${name}\n`, end = `\n// END GENERATED GLOSSARY ${name}`;
    const start = script.indexOf(begin); assert.notEqual(start,-1);
    const stop = script.indexOf(end,start); assert.notEqual(stop,-1);
    assert.equal(script.slice(start + begin.length,stop),expected);
  }
});

test('snapshot metadata has unique identifiers and provenance', () => {
  assert.equal(GLOSSARY_SOURCE.url,'https://github.com/RayanceKing/Open-Translate-Terms');
  assert.match(GLOSSARY_SOURCE.revision,/^[a-f0-9]{40}$/);
  assert.equal(GLOSSARY_SOURCE.license,'AGPL-3.0');
  assert.equal(GLOSSARY_LIBRARIES.length,36);
  assert.equal(new Set(GLOSSARY_LIBRARIES.map(l => l.id)).size,36);
  for (const l of GLOSSARY_LIBRARIES) {
    assert.ok(l.id && l.name && Array.isArray(l.langs) && l.langs.length && l.entries.length);
    for (const e of l.entries) assert.ok(e.source && typeof e.target === 'string' && e.targetLanguage);
  }
});
