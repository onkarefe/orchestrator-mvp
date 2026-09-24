import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fixtureToken, startFixtureAdmin } from './fixtures/admin-ui.mjs';

// Optional browser verification. Uses installed Chrome/Edge; no frontend dependency.
const candidates = [process.env.ADMIN_UI_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
let executable;
for (const candidate of candidates) {
  try { await fs.access(candidate); executable = candidate; break; } catch { /* try next */ }
}
if (!executable) throw new Error('Set ADMIN_UI_BROWSER to an installed Chromium browser.');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-admin-ui-'));
const fixture = await startFixtureAdmin();
const browser = spawn(executable, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--user-data-dir=' + path.join(output, 'profile'), 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const debuggerUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser startup timed out')), 20000);
    let stderr = '';
    browser.once('error', reject);
    browser.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(debuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const events = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else if (events.has(message.method)) {
      events.get(message.method)(message.params);
      events.delete(message.method);
    }
  };
  let sessionId;
  const send = (method, params = {}, browserScope = false) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP timed out: ' + method)); }, 20000);
    pending.set(requestId, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId && !browserScope ? { sessionId } : {}) }));
  });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, true)).sessionId;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setExtraHTTPHeaders', { headers: { 'x-admin-access-token': fixtureToken } });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const slugs = ['orders', 'jobs', 'webhooks', 'factory-callbacks', 'artifacts', 'shopify-update-tasks'];
  const routes = ['/admin', ...slugs.flatMap(slug => ['/admin/' + slug, '/admin/' + slug + '/1']), '/admin/orders/2'];
  const results = [];
  for (const mode of ['normal', 'long']) {
    fixture.setMode(mode);
    for (const width of [1024, 1280, 1440, 1920]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
      for (const route of routes) {
        const loaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
        await send('Page.navigate', { url: fixture.url + route });
        await loaded;
        assert.equal(await evaluate('!!document.querySelector(".admin-shell")'), true, 'Route failed: ' + route);
        for (const expanded of [false, true]) {
          if (expanded) await evaluate('document.querySelectorAll("details").forEach(d => d.open = true)');
          const dimensions = await evaluate(`(() => {
            const doc = document.documentElement;
            const main = document.querySelector('.admin-main').getBoundingClientRect();
            const sidebar = document.querySelector('.admin-sidebar').getBoundingClientRect();
            return { scroll: doc.scrollWidth, client: doc.clientWidth, body: document.body.scrollWidth,
              left: main.left, right: main.right, sidebarRight: sidebar.right,
              hidden: [doc, document.body].some(el => getComputedStyle(el).overflowX === 'hidden'),
              localScrollers: [...document.querySelectorAll('.table-scroll')].filter(el => el.scrollWidth > el.clientWidth).length };
          })()`);
          assert.ok(dimensions.scroll <= dimensions.client && dimensions.body <= dimensions.client,
            JSON.stringify({ mode, width, route, expanded, dimensions }));
          assert.ok(dimensions.left >= dimensions.sidebarRight && dimensions.right <= dimensions.client);
          assert.equal(dimensions.hidden, false, 'Overflow must not be hidden on document');
          results.push({ mode, width, route, expanded, ...dimensions });
        }
        if (mode === 'normal' && ((width === 1280 && route === '/admin/orders/1') ||
            (width === 1024 && route === '/admin/orders') || (width === 1440 && route === '/admin'))) {
          await evaluate('document.querySelectorAll("details").forEach(d => d.open = false)');
          const shot = await send('Page.captureScreenshot', { format: 'png' });
          await fs.writeFile(path.join(output, width + '-' + route.replaceAll('/', '_') + '.png'), Buffer.from(shot.data, 'base64'));
        }
      }
    }
  }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(results.length + ' browser layout checks passed; no document horizontal overflow.');
  console.log('Screenshots and measurements: ' + output);
  await send('Browser.close', {}, true);
} finally {
  socket?.close();
  if (browser.exitCode === null) browser.kill();
  await fixture.close();
}
