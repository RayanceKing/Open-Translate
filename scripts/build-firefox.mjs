// Build the Firefox MV3 package from the very same source tree as the Chrome CRX.
//
//   node scripts/build-firefox.mjs
//   VERSION=1.0.0 node scripts/build-firefox.mjs   # CI passes the manifest version
//
// Outputs (in dist/):
//   open-translate-<version>-firefox.xpi  - unsigned XPI (about:debugging / AMO upload)
//   open-translate-<version>-firefox.zip  - identical bytes, convenient for unzipping
//
// Firefox MV3 differs from Chrome in two manifest-level ways:
//   1. It does not support `background.service_worker`. It runs `background.scripts`
//      as an event page; `type: "module"` keeps the existing ESM imports working.
//   2. It needs `browser_specific_settings.gecko` (stable add-on id + min version).
// Chrome refuses to load an MV3 extension containing `background.scripts` before
// Chrome 121, so we never ship a combined manifest: the Chrome manifest stays as
// the source of truth and this script derives a Firefox-only variant.
import { readFile, writeFile, mkdir, rm, copyFile, readdir, mkdtemp, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension');
const dist = path.join(root, 'dist');

const chromeManifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
if (chromeManifest.manifest_version !== 3) throw new Error('只支持 Manifest V3');
if (chromeManifest.background?.service_worker !== 'background.js') {
  throw new Error('预期的 background.service_worker 不是 background.js，请检查 manifest 变更');
}
const version = process.env.VERSION || chromeManifest.version;
if (!/^(\d+\.){0,3}\d+$/.test(version)) throw new Error(`版本号不合法: ${version}`);

// --- Firefox-specific manifest ---------------------------------------------
const permissions = (chromeManifest.permissions || []).map(
  // Chrome's WithHostAccess variant is Chrome-specific semantics; Firefox uses
  // the plain DNR permission together with `host_permissions`.
  permission => permission === 'declarativeNetRequestWithHostAccess' ? 'declarativeNetRequest' : permission
);
const firefoxManifest = {
  ...chromeManifest,
  version,
  permissions,
  background: {
    scripts: ['background.js'],
    type: 'module'
  },
  browser_specific_settings: {
    gecko: {
      id: 'open-translate@rayanceking.dev',
      strict_min_version: '128.0',
      // AMO requires this for every new extension. The core feature sends page
      // text to third-party translation engines, which is `websiteContent`
      // transmission even though it is user-initiated, never persisted and
      // there is no telemetry. Declaring `none` would be inaccurate here.
      // Firefox 140+ surfaces this as a required data-collection consent.
      data_collection_permissions: {
        required: ['websiteContent']
      }
    }
  }
};

// --- Stage a clean copy ------------------------------------------------------
const stage = await mkdtemp(path.join(os.tmpdir(), 'ot-firefox-'));
const wanted = [];
const JUNK = /\.pem$|^\.DS_Store$/;
async function collect(relative = '') {
  const dir = relative ? path.join(src, relative) : src;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collect(rel);
    } else if (entry.isFile()) {
      if (JUNK.test(entry.name)) continue;
      wanted.push(rel);
    }
  }
}
await collect();
if (!wanted.includes('manifest.json')) throw new Error('extension/ 缺少 manifest.json');

// Copy everything except manifest.json, which we regenerate below.
await cp(src, stage, {
  recursive: true,
  filter: source => !/\.pem$|\.DS_Store$/.test(source)
});
await writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(firefoxManifest, null, 2)}\n`);

// --- Zip (XPI is just a zip with the manifest at the root) -------------------
await mkdir(dist, { recursive: true });
const base = `open-translate-${version}-firefox`;
const xpi = path.join(dist, `${base}.xpi`);
const zipPath = path.join(dist, `${base}.zip`);
// List files explicitly: `zip -r out .` can leave `./` prefixes on some builds,
// and Firefox requires manifest.json at the archive root.
execFileSync('zip', ['-X', '-q', '-9', xpi, ...wanted], { cwd: stage, stdio: 'inherit' });
await copyFile(xpi, zipPath);

// --- Self-check --------------------------------------------------------------
execFileSync('unzip', ['-t', '-q', xpi], { stdio: 'inherit' });
const entries = execFileSync('unzip', ['-Z1', xpi], { cwd: stage, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const missing = wanted.filter(file => !entries.includes(file));
if (missing.length) throw new Error(`XPI 缺少文件: ${missing.join(', ')}`);
if (!entries.includes('manifest.json')) throw new Error('XPI 根目录缺少 manifest.json');
if (entries.some(file => file.startsWith('./') || file.startsWith('/'))) {
  throw new Error('XPI 条目包含非相对路径前缀');
}
const packed = JSON.parse(execFileSync('unzip', ['-p', xpi, 'manifest.json'], { cwd: stage, encoding: 'utf8' }));
if (packed.manifest_version !== 3) throw new Error('打包后的 manifest_version 不是 3');
if (packed.background?.service_worker) throw new Error('Firefox 包里不应有 service_worker');
if (packed.background?.type !== 'module' || !packed.background?.scripts?.includes('background.js')) {
  throw new Error('Firefox 包必须使用 background.scripts + type: module');
}
const gecko = packed.browser_specific_settings?.gecko;
if (!gecko?.id) throw new Error('缺少 gecko add-on id');
if (!Array.isArray(gecko.data_collection_permissions?.required) || !gecko.data_collection_permissions.required.length) {
  throw new Error('缺少必填的 data_collection_permissions.required（AMO 上架硬性要求）');
}
if (packed.version !== version) throw new Error('打包后的版本号与预期不一致');

await rm(stage, { recursive: true, force: true });
console.log(`Firefox 包已生成: ${path.relative(root, xpi)}、${path.relative(root, zipPath)}`);
console.log(`  ${entries.length} 个文件，gecko id ${packed.browser_specific_settings.gecko.id}，最低 Firefox ${packed.browser_specific_settings.gecko.strict_min_version}`);
