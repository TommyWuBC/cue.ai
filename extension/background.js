import { SERVER_URL } from './runtime.js';

const SERVER = new URL(SERVER_URL);

function supported(url) {
  try {
    const page = new URL(url);
    return ['http:', 'https:'].includes(page.protocol) && page.origin !== SERVER.origin;
  } catch { return false; }
}

async function serverReady() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(new URL('/health', SERVER), {
      signal: controller.signal, cache: 'no-store',
    });
    return response.ok && (await response.json()).ok === true;
  } catch { return false; }
  finally { clearTimeout(timeout); }
}

async function activeOn(tabId) {
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId }, func: () => Boolean(globalThis.__cueExternalActive),
  });
  return Boolean(frame?.result);
}

async function start(tab) {
  if (!tab?.id || !supported(tab.url)) {
    return { ok: false, error: 'Open a shopping page over HTTPS, then try again.' };
  }
  const target = { tabId: tab.id };
  try {
    if (await activeOn(tab.id)) return { ok: true, active: true };
    if (!await serverReady()) {
      return { ok: false, error: `Cue cannot reach ${SERVER.origin}. Start the server and try again.` };
    }

    const models = Object.fromEntries(['blazeface', 'facemesh', 'iris'].map(name =>
      [name, chrome.runtime.getURL(`vendor/models/${name}/model.json`)]));
    await chrome.scripting.executeScript({
      target,
      func: (server, urls) => {
        globalThis.CUE_MODELS = urls;
        globalThis.CUE_CONFIG = { server, gazeMode: 'webgazer', autoCal: true,
          keepData: false, models: urls };
      },
      args: [SERVER.origin, models],
    });
    await chrome.scripting.insertCSS({ target, files: ['client/overlay.css'] });
    await chrome.scripting.executeScript({ target, files: ['vendor/webgazer.js'] });
    await chrome.scripting.executeScript({ target, files: ['extension/extract.js', 'extension/content.js'] });
    return { ok: true, active: true };
  } catch (error) {
    console.error('[cue] Could not start on this page:', error);
    return { ok: false, error: 'Chrome blocked Cue on this page. Try a normal shopping tab.' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (sender.url === chrome.runtime.getURL('extension/popup.html') && message?.type === 'cue:start') {
    start(message.tab).then(respond, () => respond({ ok: false, error: 'Cue could not start.' }));
    return true;
  }
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return;
  const key = `cue.product-memory.${tabId}`;
  if (message?.type === 'cue:memory:read') {
    chrome.storage.session.get(key).then(data => respond({ value: data[key] ?? null }),
      () => respond({ value: null }));
    return true;
  }
  if (message?.type === 'cue:memory:write' && typeof message.value === 'string' &&
      message.value.length <= 10000) {
    chrome.storage.session.set({ [key]: message.value }).then(() => respond({ ok: true }),
      () => respond({ ok: false }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`cue.product-memory.${tabId}`).catch(() => {});
});
