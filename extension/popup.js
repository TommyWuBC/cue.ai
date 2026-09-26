import { SERVER_URL } from './runtime.js';

const status = document.getElementById('status');
const start = document.getElementById('start');
const demo = document.getElementById('demo');
const server = new URL(SERVER_URL);
demo.href = server.origin;
demo.addEventListener('click', event => {
  event.preventDefault();
  chrome.tabs.create({ url: server.origin });
});

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function check() {
  let healthy = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(new URL('/health', server), {
        signal: controller.signal, cache: 'no-store',
      });
      healthy = response.ok && (await response.json()).ok === true;
    } finally { clearTimeout(timer); }
  } catch {}
  if (!healthy) {
    status.textContent = `Cue server is offline at ${server.origin}. Start it, then reopen this panel.`;
    return;
  }
  const tab = await currentTab();
  if (!tab?.url || !/^https?:\/\//.test(tab.url) || new URL(tab.url).origin === server.origin) {
    status.textContent = 'Open a shopping page, then start Cue here.';
    return;
  }
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: () => Boolean(globalThis.__cueExternalActive),
    });
    if (frame?.result) {
      status.textContent = 'Cue is running on this page.';
      start.textContent = 'Cue is active';
      return;
    }
  } catch {}
  status.textContent = 'Ready. Start Cue on this page to calibrate your eyes.';
  start.disabled = false;
}

start.addEventListener('click', async () => {
  start.disabled = true;
  status.textContent = 'Starting Cue…';
  try {
    const tab = await currentTab();
    const result = await chrome.runtime.sendMessage({ type: 'cue:start', tab });
    if (!result?.ok) throw new Error(result?.error || 'Cue could not start.');
    status.textContent = 'Cue is starting. Follow the calibration dots on the page.';
    start.textContent = 'Cue is active';
    // The two-second logo is on the shopping tab, behind this toolbar panel.
    // Close the panel as soon as injection succeeds so the shopper sees it.
    window.close();
  } catch (error) {
    status.textContent = error.message;
    start.disabled = false;
  }
});

check().catch(error => { status.textContent = `Cue could not check this page: ${error.message}`; });
