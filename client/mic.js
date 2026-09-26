// Grok streaming speech-to-text.
//
// Mic -> AudioWorklet -> 16 kHz PCM16 -> our /stt websocket -> xAI.
// The key stays on the server; the page only ever talks to our own origin.
//
// This exists because the browser's SpeechRecognition is unusable on a
// hackathon floor: it needs near-silence, it has no push-to-talk finalisation,
// and Chrome kills the session every ~60 seconds.

import { bus } from "./bus.js";

const TARGET_RATE   = 16000;
const CHUNK_SAMPLES = 1600;          // 100 ms — xAI's suggested frame size

// Inline so there is no second file to serve or get stale in cache.
const WORKLET_SRC = `
class CueTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const s = ch[i] < -1 ? -1 : ch[i] > 1 ? 1 : ch[i];
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('cue-tap', CueTap);
`;

const st = { ctx: null, ws: null, node: null, stream: null, src: null,
             running: false, ready: false, muted: false };
let carry = [];
let carryLen = 0;

function flush(force = false) {
  while (carryLen >= CHUNK_SAMPLES || (force && carryLen > 0)) {
    const take = Math.min(CHUNK_SAMPLES, carryLen);
    const out = new Int16Array(take);
    let filled = 0;
    while (filled < take) {
      const head = carry[0];
      const need = take - filled;
      if (head.length <= need) { out.set(head, filled); filled += head.length; carry.shift(); }
      else { out.set(head.subarray(0, need), filled); carry[0] = head.subarray(need); filled += need; }
    }
    carryLen -= take;
    if (st.ws?.readyState === WebSocket.OPEN && !st.muted) st.ws.send(out.buffer);
    if (!force) continue;
    if (carryLen === 0) break;
  }
}

export async function start() {
  if (st.running) return true;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/stt`);
  ws.binaryType = "arraybuffer";
  st.ws = ws;

  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 6000);
    ws.onopen  = () => { clearTimeout(t); resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
  });
  if (!opened) { console.warn("[cue] stt socket failed to open"); return false; }

  let unavailable = false;
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case "cue.unavailable":
        unavailable = true;
        console.warn("[cue] grok stt unavailable:", m.reason);
        bus.emit("STATE", { sttProvider: "browser", sttError: m.reason });
        break;
      case "transcript.created":
        st.ready = true;
        bus.emit("STATE", { sttProvider: "grok" });
        console.log("[cue] grok stt live");
        break;
      case "transcript.partial":
        if (!m.text) break;
        // is_final+speech_final = the speaker actually stopped. is_final alone
        // is just a locked chunk mid-sentence, which is not a command yet.
        bus.emit("STT", { text: m.text, final: !!(m.is_final && m.speech_final) });
        break;
      case "transcript.done":
        if (m.text) bus.emit("STT", { text: m.text, final: true });
        break;
    }
  };
  ws.onclose = () => {
    st.ready = false;
    if (st.running && !unavailable) {
      console.warn("[cue] stt socket closed — retrying");
      setTimeout(() => { st.running = false; start(); }, 1200);
    }
  };

  // echoCancellation is what stops the mic transcribing Cue's own voice.
  try {
    st.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true,
               noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    console.warn("[cue] mic denied:", e.name);
    bus.emit("STATE", { listening: false, micError: e.name });
    ws.close();
    return false;
  }

  // Asking the context for 16 kHz makes the browser do the resampling for us.
  st.ctx = new AudioContext({ sampleRate: TARGET_RATE });
  if (st.ctx.state === "suspended") await st.ctx.resume();

  const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await st.ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  st.src  = st.ctx.createMediaStreamSource(st.stream);
  st.node = new AudioWorkletNode(st.ctx, "cue-tap");
  st.node.port.onmessage = (e) => {
    carry.push(e.data); carryLen += e.data.length;
    flush();
  };
  st.src.connect(st.node);
  // A worklet with no downstream connection is allowed to be culled. Route it
  // into a silent gain node so it is never optimised away mid-demo.
  const sink = st.ctx.createGain();
  sink.gain.value = 0;
  st.node.connect(sink).connect(st.ctx.destination);

  st.running = true;
  bus.emit("STATE", { listening: true, sttProvider: "grok" });
  return true;
}

/** Release of push-to-talk: cut the utterance now, don't wait out the silence. */
export function finalize() {
  flush(true);
  if (st.ws?.readyState === WebSocket.OPEN) st.ws.send(JSON.stringify({ type: "Finalize" }));
}

/** Cut the audio feed entirely. Debug use only — the speaking path deliberately
 *  does NOT call this, because muting the mic while Cue talks kills barge-in. */
export function setMuted(m) { st.muted = !!m; }

export function stop() {
  st.running = false;
  try { st.node?.disconnect(); st.src?.disconnect(); } catch {}
  try { st.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { st.ctx?.close(); } catch {}
  try { st.ws?.close(); } catch {}
  carry = []; carryLen = 0;
}

export const getMicState = () => ({
  running: st.running, ready: st.ready, muted: st.muted,
  ws: st.ws?.readyState, rate: st.ctx?.sampleRate,
});
