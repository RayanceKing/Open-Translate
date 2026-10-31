import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

// Native CDP keeps browser smoke tests dependency-free. Use a disposable profile,
// never the user's normal browser session. BROWSER_PATH overrides the local Edge.
export async function launchBrowser(extensionPath) {
  const directory = await mkdtemp(join(tmpdir(), 'open-translate-smoke-'));
  const executable = process.env.BROWSER_PATH || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--window-size=1440,1100'];
  if (extensionPath) args.push(`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`);
  args.push('about:blank');
  const processHandle = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Browser startup timed out: ${stderr}`)), 20000);
    processHandle.on('error', error => { clearTimeout(timer); reject(error); });
    processHandle.on('exit', code => { clearTimeout(timer); reject(new Error(`Browser exited (${code}): ${stderr}`)); });
    processHandle.stderr.on('data', chunk => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  }).catch(error => { processHandle.kill(); throw error; });
  const socket = new WebSocket(endpoint);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    } else if (message.method) events.push(message);
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async function attach(targetId) {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    return {
      targetId, sessionId,
      send: (method, params) => send(method, params, sessionId),
      async evaluate(expression) {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      },
      async screenshot(name) {
        await mkdir(join(directory, 'screenshots'), { recursive: true });
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
        const path = join(directory, 'screenshots', `${name}.png`);
        await writeFile(path, Buffer.from(data, 'base64'));
        return path;
      }
    };
  }
  return {
    directory, events, send, attach,
    async page(url = 'about:blank') {
      const { targetId } = await send('Target.createTarget', { url });
      const page = await attach(targetId);
      await page.send('Page.enable');
      return page;
    },
    async close() {
      await send('Browser.close').catch(() => {});
      socket.close();
      if (processHandle.exitCode === null) {
        const timer = setTimeout(() => processHandle.kill(), 3000);
        await once(processHandle, 'exit');
        clearTimeout(timer);
      }
    }
  };
}

export async function waitUntil(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { last = await check(); if (last) return last; } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}
