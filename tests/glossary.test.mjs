import test from 'node:test';
import assert from 'node:assert/strict';
import { GLOSSARY_SOURCE, GLOSSARY_LIBRARIES } from '../extension/lib/glossary-data.js';
import { normalizeGlossarySettings, parseCustomTerms, serializeGlossaryCsv, resolveGlossary, glossarySalt, matchGlossary, formatGlossary, protectGlossary } from '../extension/lib/glossary.js';

test('pinned upstream data includes every library and valid entries', () => {
  assert.equal(GLOSSARY_LIBRARIES.length, 36);
  assert.equal(new Set(GLOSSARY_LIBRARIES.map(x => x.id)).size, 36);
  assert.equal(GLOSSARY_SOURCE.revision, 'b4c8f15eaddb98337151fe4dbdc463eb2aa45330');
  assert.equal(GLOSSARY_SOURCE.license, 'AGPL-3.0');
  assert.ok(GLOSSARY_LIBRARIES.reduce((n, l) => n + l.entries.length, 0) > 5000);
  for (const library of GLOSSARY_LIBRARIES) for (const entry of library.entries) {
    assert.ok(entry.source); assert.equal(typeof entry.target, 'string'); assert.ok(entry.targetLanguage);
  }
});
test('normalization preserves explicit values and migrates legacy scope', () => {
  assert.deepEqual(normalizeGlossarySettings(null, 'a = b'), {enabled:true,machineTranslation:false,libraryIds:[],customTerms:'a = b',customTargetLanguage:'*'});
  assert.equal(normalizeGlossarySettings({customTerms:''}, 'a = b').customTerms, '');
});
test('CSV and equals syntax support quoting, empty target, and round trip', () => {
  const entries = parseCustomTerms('source,target,tgt_lng\n"a,b","say ""hi""",zh-CN\nfoo,,\n');
  assert.deepEqual(entries, [{source:'a,b',target:'say "hi"',targetLanguage:'zh-CN'}, {source:'foo',target:'',targetLanguage:'*'}]);
  assert.deepEqual(parseCustomTerms(serializeGlossaryCsv(entries)), entries);
  const formulaTerms = [{source:'=1+1', target:'@SUM(A1:A2)', targetLanguage:'*'}];
  const safeCsv = serializeGlossaryCsv(formulaTerms);
  assert.ok(!safeCsv.includes('"=1+1"'));
  assert.deepEqual(parseCustomTerms(safeCsv), formulaTerms);
  assert.equal(parseCustomTerms('  foo = bar = baz  ')[0].target, 'bar = baz');
  assert.deepEqual(parseCustomTerms('term = first, second, third'), [{source:'term',target:'first, second, third',targetLanguage:'*'}]);
  assert.deepEqual(parseCustomTerms('term = say "hello, friend"'), [{source:'term',target:'say "hello, friend"',targetLanguage:'*'}]);
  assert.throws(() => parseCustomTerms('broken'), /格式错误/);
  assert.throws(() => parseCustomTerms('"bad,x'), /引号/);
  assert.throws(() => parseCustomTerms(',x'), /格式错误/);
});
test('custom terms override builtins, specific wins universal, target filters', () => {
  const settings = {glossary: {libraryIds:['programming'], customTerms:'Python,universal,*\nPython,specific,zh-CN\nPython,wrong,zh-TW'}};
  assert.equal(resolveGlossary(settings, 'zh-CN').find(e => e.source === 'Python').target, 'specific');
  assert.equal(resolveGlossary(settings, 'zh-TW').find(e => e.source === 'Python').target, 'wrong');
  assert.equal(glossarySalt(settings,'zh-CN',false), '');
  assert.ok(glossarySalt(settings,'zh-CN',true));
  settings.glossary.machineTranslation = true;
  assert.ok(glossarySalt(settings,'zh-CN',false));
  settings.glossary.enabled = false; assert.equal(glossarySalt(settings,'zh-CN',true), '');
});
test('longest match wins; boundaries, case, CJK and privacy placeholders', () => {
  const e = [{source:'cat',target:'猫'},{source:'cat food',target:'猫粮'},{source:'PRIVATE',target:'泄漏'},{source:'中文',target:'Chinese'}];
  const texts = ['CAT food cat scatter 中文测试 __OT_PRIVATE_0__'];
  assert.deepEqual(matchGlossary(texts,e), [e[0],e[1],e[3]]);
  assert.ok(!formatGlossary(texts,e).includes('PRIVATE'));
  const p = protectGlossary(texts,e); const result = p.restore(p.safe[0],0);
  assert.equal(result.valid,true); assert.equal(result.text, '猫粮 猫 scatter Chinese测试 __OT_PRIVATE_0__');
});
test('placeholder damage, duplication and cross-segment substitution are invalid', () => {
  const p = protectGlossary(['a a','a'], [{source:'a',target:'X'}]);
  assert.equal(p.restore(p.safe[0],0).text, 'X X');
  assert.equal(p.restore(p.safe[0].replace(/__OT_GLOSSARY_\w+_0_0__/, ''),0).valid,false);
  assert.equal(p.restore(p.safe[0] + p.safe[0],0).valid,false);
  assert.equal(p.restore(p.safe[1],0).valid,false);
  assert.equal(p.restore(p.safe[0],99).valid,false);
});
