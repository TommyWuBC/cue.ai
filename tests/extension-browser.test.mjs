// Run with CUE_CHROME_PATH pointing to Chrome for Testing or Chromium.
// This exercises the built extension in a real browser; DOM-only tests cannot
// catch Chrome refusing a content script's module imports or model resources.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const chromePath = process.env.CUE_CHROME_PATH;

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return server;
}

test('unpacked extension mounts Cue, avatar, products, and local model assets',
  { skip: !chromePath && 'Set CUE_CHROME_PATH to a Chromium executable' }, async t => {
    const backend = await listen((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/health' ? '{"ok":true}' : '{}');
    });
    const shop = await listen((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><body><main>
        <div data-component-type="s-search-result" data-asin="B0CUE12345"
             style="width:320px;height:220px">
          <h2>Northfield</h2>
          <a href="/dp/B0CUE12345"><h2 aria-label="Cotton Jacket">Cotton Jacket</h2></a>
          <span class="a-price"><span class="a-offscreen">$49.00</span></span>
        </div></main></body></html>`);
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await Promise.all([backend, shop].map(server => new Promise(done => server.close(done))));
    });

    const backendPort = backend.address().port;
    const built = spawnSync('python3', ['tools/build-extension.py', '--server-url',
      `http://localhost:${backendPort}`], { cwd: root, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const extension = resolve(root, 'dist/cue-extension');
    // A tab opened by automation never receives a toolbar-click activeTab
    // grant. Give only this disposable fixture origin access in the test copy.
    const manifestFile = resolve(extension, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.host_permissions.push(`http://localhost:${shop.address().port}/*`);
    await writeFile(manifestFile, JSON.stringify(manifest));
    browser = await puppeteer.launch({
      executablePath: chromePath, headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--no-first-run', '--no-default-browser-check'],
    });
    const worker = await browser.waitForTarget(target =>
      target.type() === 'service_worker' && target.url().endsWith('/extension/background.js'),
    { timeout: 15000 });
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
    const shopPage = await browser.newPage();
    const modelResponses = [];
    const remoteModelRequests = [];
    shopPage.on('response', response => {
      if (response.url().includes('/vendor/models/'))
        modelResponses.push({ url: response.url(), status: response.status() });
    });
    shopPage.on('request', request => {
      if (request.url().includes('tfhub.dev')) remoteModelRequests.push(request.url());
    });
    const shopUrl = `http://localhost:${shop.address().port}/search`;
    await shopPage.goto(shopUrl);

    const popup = await browser.newPage();
    await popup.goto(`${extensionOrigin}/extension/popup.html`);
    // A popup opened as an ordinary tab by Puppeteer does not receive Chrome's
    // activeTab grant. Send the same request from that popup with the known
    // shopping tab ID; the background still verifies the sender and injects.
    const started = await popup.evaluate(async url => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.runtime.sendMessage({ type: 'cue:start',
        tab: { id: tab.openerTabId, url } });
    }, shopUrl);
    assert.equal(started?.ok, true, JSON.stringify(started));
    await shopPage.waitForSelector('#aura-root .aura-hud .cue-avatar svg', { timeout: 15000 });
    await shopPage.waitForSelector('[data-asin="B0CUE12345"][data-cue-product]');

    const product = await shopPage.$eval('[data-asin="B0CUE12345"]', el =>
      JSON.parse(el.dataset.cueProduct));
    assert.equal(product.title, 'Cotton Jacket');
    assert.equal(product.price, 49);

    const model = await shopPage.evaluate(async origin => {
      const response = await fetch(`${origin}/vendor/models/blazeface/model.json`);
      return { status: response.status, data: await response.json() };
    }, extensionOrigin);
    assert.equal(model.status, 200);
    assert.ok(model.data.weightsManifest?.length);
    const requiredModels = ['blazeface', 'facemesh'].flatMap(name => [
      `/vendor/models/${name}/model.json`,
      `/vendor/models/${name}/group1-shard1of1.bin`,
    ]);
    const allLoaded = () => requiredModels.every(path =>
      modelResponses.some(response => response.url.endsWith(path) && response.status === 200));
    if (!allLoaded()) await new Promise((done, reject) => {
      const timeout = setTimeout(() => {
        shopPage.off('response', check);
        reject(new Error(`Local model loads timed out: ${JSON.stringify(modelResponses)}`));
      }, 12000);
      const check = () => {
        if (!allLoaded()) return;
        clearTimeout(timeout);
        shopPage.off('response', check);
        done();
      };
      shopPage.on('response', check);
    });
    assert.deepEqual(remoteModelRequests, []);
  });
