import { localAnalyticsRequest } from "./analytics-store.js";

let serial = 0;

function bridgeRequest(kind, event) {
  const id = `cue-${Date.now()}-${++serial}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Browser storage did not respond.")); }, 5000);
    const onResponse = response => {
      let detail;
      try { detail = JSON.parse(response.detail); } catch { return; }
      if (detail.id !== id) return;
      cleanup();
      if (detail.ok) resolve(detail.data);
      else reject(new Error(detail.error || "Browser storage is unavailable."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener("cue:analytics:response", onResponse);
    };
    document.addEventListener("cue:analytics:response", onResponse);
    document.dispatchEvent(new CustomEvent("cue:analytics:request", {
      detail: JSON.stringify({ id, kind, event }),
    }));
  });
}

export async function analyticsRequest(kind, event = null, { injected = false } = {}) {
  if (injected && globalThis.chrome?.runtime?.sendMessage) {
    const response = await chrome.runtime.sendMessage({ type: `cue:analytics:${kind}`, event });
    if (!response?.ok) throw new Error(response?.error || "Browser storage is unavailable.");
    return response.data;
  }
  if (document.documentElement?.dataset.cueAnalyticsBridge === "1") return bridgeRequest(kind, event);
  return localAnalyticsRequest(kind, event);
}

export function downloadAnalyticsCSV(csv) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "cue-shopping-analytics.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
