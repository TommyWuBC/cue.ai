import { CONFIG, wsUrl } from "./config.js";

const REQUEST_TIMEOUT_MS = 5000;

/** Browser half of Cue's local EyeTrax companion protocol. */
class EyeTraxClient {
  constructor() {
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.latest = null;
    this.ready = null;
    this.onGaze = null;
    this.onQuality = null;
  }

  async connect({ token = CONFIG.gazeToken, width = innerWidth, height = innerHeight,
    onGaze, onQuality } = {}) {
    this.close(false);
    this.onGaze = onGaze;
    this.onQuality = onQuality;
    const endpoint = new URL(wsUrl("/gaze"));
    if (token) endpoint.searchParams.set("token", token);
    const socket = new WebSocket(endpoint);
    this.socket = socket;

    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("EyeTrax did not become ready")), 45_000);
      const fail = (error) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("EyeTrax connection failed"));
      };
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", width, height }));
      }, { once: true });
      socket.addEventListener("error", () => fail(new Error("Could not connect to EyeTrax")),
        { once: true });
      socket.addEventListener("close", (event) => {
        if (!this.latest) fail(new Error(event.reason || "EyeTrax connection closed"));
        this._rejectPending(new Error(event.reason || "EyeTrax connection closed"));
      });
      socket.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); }
        catch { return; }
        if (message.type === "ready") {
          clearTimeout(timeout);
          resolve(message);
          return;
        }
        if (message.type === "error") {
          fail(new Error(message.message || "EyeTrax failed"));
          return;
        }
        if (message.type === "gaze") {
          this.latest = { x: message.x, y: message.y, ageMs: message.age_ms,
            sequence: message.sequence, receivedAt: performance.now() };
          this.onGaze?.(this.latest);
          return;
        }
        if (message.type === "quality") {
          this.onQuality?.(message);
          return;
        }
        if (message.id && this.pending.has(message.id)) {
          const entry = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(entry.timeout);
          if (message.ok === false && message.type !== "captured") {
            entry.reject(new Error(message.error || message.reason));
          }
          else entry.resolve(message);
        }
      });
    });
    return this.ready;
  }

  request(type, data = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("EyeTrax is disconnected"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`EyeTrax ${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ type, id, ...data }));
    });
  }

  async reset() {
    this.latest = null;
    return this.request("reset");
  }

  async capture(x, y) {
    try {
      return await this.request("capture", { x, y }, 1200);
    } catch (error) { return { ok: false, reason: error.message }; }
  }

  train() { return this.request("train", {}, 15_000); }

  setAccuracy(value) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "accuracy", value }));
    }
  }

  getCurrentPrediction(maxAgeMs = 750) {
    const point = this.latest;
    if (!point || performance.now() - point.receivedAt > maxAgeMs) return null;
    return { x: point.x, y: point.y, ageMs: point.ageMs, sequence: point.sequence };
  }

  close(shutdown = true) {
    const socket = this.socket;
    this.socket = null;
    this.latest = null;
    if (socket?.readyState === WebSocket.OPEN && shutdown) {
      try { socket.send(JSON.stringify({ type: "shutdown", id: this.nextId++ })); } catch {}
    }
    try { socket?.close(); } catch {}
    this._rejectPending(new Error("EyeTrax stopped"));
  }

  _rejectPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

export const eyeTrax = new EyeTraxClient();
export { EyeTraxClient };
