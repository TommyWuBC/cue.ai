// Run with CUE_CHROME_PATH pointing to Chrome for Testing or Chromium.
// This exercises the built extension in a real browser; DOM-only tests cannot
// catch Chrome refusing content-script module imports or the gaze websocket.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

test('unpacked extension mounts Cue and reconnects to its EyeTrax companion',
  { skip: !chromePath && 'Set CUE_CHROME_PATH to a Chromium executable' }, async t => {
    let gazeConnections = 0;
    let gazeSessionOrigin = null;
    const sockets = new Set();
    const backend = await listen((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.url === '/api/gaze/session') gazeSessionOrigin = req.headers.origin;
      res.end(req.url === '/health' ? '{"ok":true}'
        : req.url === '/api/gaze/session' ? JSON.stringify({ token: 't'.repeat(43) }) : '{}');
    });
    backend.on('upgrade', (req, socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      const accept = createHash('sha1').update(
        req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const connection = ++gazeConnections;
      const send = value => {
        const body = Buffer.from(JSON.stringify(value));
        socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
      };
      let incoming = Buffer.alloc(0);
      socket.on('data', chunk => {
        incoming = Buffer.concat([incoming, chunk]);
        while (incoming.length >= 6) {
          let length = incoming[1] & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (incoming.length < 8) return;
            length = incoming.readUInt16BE(2); offset = 4;
          }
          const masked = (incoming[1] & 0x80) !== 0;
          const frameLength = offset + (masked ? 4 : 0) + length;
          if (incoming.length < frameLength) return;
          const mask = masked ? incoming.subarray(offset, offset + 4) : null;
          if (masked) offset += 4;
          const body = Buffer.from(incoming.subarray(offset, offset + length));
          if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
          incoming = incoming.subarray(frameLength);
          try {
            const message = JSON.parse(body.toString());
            if (message.type === 'reset') send({ type: 'reset', id: message.id, ok: true });
          } catch {}
        }
      });
      setTimeout(() => {
        send({ type: 'ready', calibrated: connection > 1,
          accuracy: connection > 1 ? { after_px: 90, held_out: true } : null });
      }, 50);
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
      for (const socket of sockets) socket.destroy();
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
    const shopUrl = `http://localhost:${shop.address().port}/search`;
    await shopPage.goto(shopUrl);

    const popup = await browser.newPage();
    await popup.goto(`${extensionOrigin}/extension/popup.html`);
    // A popup opened as an ordinary tab by Puppeteer does not receive Chrome's
    // activeTab grant. Send the same request from that popup with the known
    // shopping tab ID; the background still verifies the sender and injects.
    const started = await popup.evaluate(async url => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.runtime.sendMessage({ type: 'cue:start',
        tab: { id: tab.openerTabId, url } });
      return { ...result, tabId: tab.openerTabId };
    }, shopUrl);
    assert.equal(started?.ok, true, JSON.stringify(started));
    assert.equal(gazeSessionOrigin, extensionOrigin);
    // The real toolbar popup closes after activation. Bring the shopping tab
    // forward here so Chrome paints its two-second fade at normal frame rate.
    await shopPage.bringToFront();
    const splashStartedAt = Date.now();
    await shopPage.waitForSelector('.cue-splash', { timeout: 5000 });
    let opacity = 0;
    for (let attempt = 0; attempt < 30 && opacity <= .8; attempt++) {
      opacity = await shopPage.evaluate(() => {
        const layer = document.querySelector('.cue-splash');
        return layer ? Number(getComputedStyle(layer).opacity) : 0;
      });
      if (opacity <= .8) await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(opacity > .8, 'the logo should dissolve in');
    const splash = await shopPage.evaluate(() => {
      const layer = document.querySelector('.cue-splash');
      const image = layer.querySelector('img');
      return { source: image.src, loaded: image.complete && image.naturalWidth > 0,
        abovePage: layer.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2)),
        calibrationStarted: !!document.querySelector('.aura-cal') };
    });
    assert.equal(splash.source, `${extensionOrigin}/extension/assets/cue-splash.jpg`);
    assert.equal(splash.loaded, true);
    assert.equal(splash.abovePage, true);
    assert.equal(splash.calibrationStarted, false);
    let splashGone = false;
    for (let attempt = 0; attempt < 100 && !splashGone; attempt++) {
      splashGone = await shopPage.evaluate(() => !document.querySelector('.cue-splash'));
      if (!splashGone) await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(splashGone, true, 'the logo should dissolve away before calibration');
    assert.ok(Date.now() - splashStartedAt >= 1700, 'logo should stay on screen for about two seconds');
    assert.equal(shopPage.url(), shopUrl, 'startup must stay on the original shopping page');
    await shopPage.waitForSelector('#aura-root .aura-hud .cue-avatar svg', { timeout: 15000 });
    await shopPage.waitForSelector('[data-asin="B0CUE12345"][data-cue-product]');

    const product = await shopPage.$eval('[data-asin="B0CUE12345"]', el =>
      JSON.parse(el.dataset.cueProduct));
    assert.equal(product.title, 'Cotton Jacket');
    assert.equal(product.price, 49);

    // Puppeteer's utility world cannot reliably see elements inserted by this
    // extension's isolated world. page.evaluate runs in the page's main world.
    let calibrationVisible = false;
    for (let attempt = 0; attempt < 120 && !calibrationVisible; attempt++) {
      calibrationVisible = await shopPage.evaluate(() => {
        const cal = document.querySelector('.aura-cal');
        const dot = cal?.querySelector('.aura-cal-dot');
        if (!cal || !dot) return false;
        const rect = cal.getBoundingClientRect();
        return rect.width >= innerWidth && rect.height >= innerHeight &&
          getComputedStyle(cal).visibility === 'visible' &&
          getComputedStyle(dot).backgroundColor === 'rgb(247, 247, 245)' &&
          getComputedStyle(cal).backgroundImage.includes('rgb(5, 5, 5)') &&
          document.elementFromPoint(innerWidth / 2, innerHeight / 2) === cal;
      });
      if (!calibrationVisible) await new Promise(done => setTimeout(done, 100));
    }
    const calibrationState = await shopPage.evaluate(() => ({
      gaze: globalThis.cue?.gaze.getState(),
      said: document.querySelector('.aura-hud-said')?.textContent,
      calibration: !!document.querySelector('.aura-cal'),
    }));
    const [isolated] = await popup.evaluate(async tabId => chrome.scripting.executeScript({
      target: { tabId }, func: () => ({ config: globalThis.CUE_CONFIG,
        gaze: globalThis.cue?.gaze.getState(), active: globalThis.__cueExternalActive }) }),
    started.tabId);
    assert.equal(calibrationVisible, true,
      `the white calibration dot must be visible on black: ${JSON.stringify({ calibrationState, isolated: isolated.result, gazeConnections })}`);

    // A full Amazon-style product navigation replaces the page's JS world.
    // Seed the compact EyeTrax metadata in extension storage. The companion
    // retains the fitted model in memory and reports it on the next connection.
    const viewport = await shopPage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const calibration = { version: 2, engine: 'eyetrax', viewport,
      accuracy: { after_px: 90, before_px: 120, samples: 70, held_out: true } };
    const [write] = await popup.evaluate(async ({ tabId, calibration }) =>
      chrome.scripting.executeScript({ target: { tabId },
        func: value => chrome.runtime.sendMessage({
          type: 'cue:calibration:write', value,
        }), args: [calibration] }),
    { tabId: started.tabId, calibration });
    assert.deepEqual(write.result, { ok: true });

    const productUrl = `http://localhost:${shop.address().port}/dp/B0CUE12345`;
    await shopPage.goto(productUrl);
    await shopPage.waitForSelector('#aura-root', { timeout: 15000 });
    let resumed = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      const [frame] = await popup.evaluate(async tabId => chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({ active: globalThis.__cueExternalActive,
          resuming: globalThis.CUE_CONFIG?.resuming,
          calibrated: globalThis.cue?.gaze.getState().calibrated,
          splash: !!document.querySelector('.cue-splash'),
          calibration: !!document.querySelector('.aura-cal') }),
      }), started.tabId);
      resumed = frame.result;
      if (resumed?.calibrated || resumed?.calibration) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(shopPage.url(), productUrl);
    assert.deepEqual(resumed, { active: true, resuming: true, calibrated: true,
      splash: false, calibration: false });
    const [saved] = await popup.evaluate(async tabId => chrome.scripting.executeScript({
      target: { tabId }, func: () => {
        const snapshot = globalThis.cue?.gaze.exportCalibration();
        return { version: snapshot?.version, engine: snapshot?.engine,
          error: snapshot?.accuracy?.after_px };
      },
    }), started.tabId);
    assert.deepEqual(saved.result, { version: 2, engine: 'eyetrax', error: 90 });
  });
