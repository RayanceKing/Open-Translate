// Embed the same local modules into existing userscript marker regions.
// Run only after the userscript contains both marker pairs.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userscript = path.join(root, 'tampermonkey/open-translate.user.js');
const data = await readFile(path.join(root, 'extension/lib/glossary-data.js'), 'utf8');
const core = await readFile(path.join(root, 'extension/lib/glossary.js'), 'utf8');
let output = await readFile(userscript, 'utf8');
function embed(name, module) {
  const begin = `// BEGIN GENERATED GLOSSARY ${name}`, end = `// END GENERATED GLOSSARY ${name}`;
  const start = output.indexOf(begin), stop = output.indexOf(end);
  if (start < 0 || stop < start || output.indexOf(begin, start + begin.length) !== -1 || output.indexOf(end, stop + end.length) !== -1) throw new Error(`Expected exactly one ${name} marker pair`);
  const code = module.replace(/^import\s+[^\n]+\n/gm, '').replace(/^export\s+/gm, '').trimEnd();
  output = output.slice(0, start + begin.length) + '\n' + code + '\n' + output.slice(stop);
}
embed('DATA', data);
embed('CORE', core);
await writeFile(userscript, output);
console.log('Embedded glossary data and core');
