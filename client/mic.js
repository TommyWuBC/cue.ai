// Grok streaming speech-to-text.
//
// Mic -> AudioWorklet -> 16 kHz PCM16 -> our /stt websocket -> xAI.
// The key stays on the server; the page only ever talks to our own origin.
//
// This exists because the browser's SpeechRecognition is unusable on a
// hackathon floor: it needs near-silence, it has no push-to-talk finalisation,
// and Chrome kills the session every ~60 seconds.

import { bus } from "./bus.js";
import { wsUrl, url } from "./config.js";

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
let generation = 0;

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
  const mine = ++generation;

  // Get the mic BEFORE opening the socket. Grok bills streaming by the hour,
  // and the old order opened an upstream session to xAI and then discovered
  // there was no audio to put in it.
  try {
    st.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true,
               noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    console.warn("[cue] mic denied:", e.name);
    bus.emit("STATE", { listening: false, micError: e.name });
    return false;
  }

  if (mine !== generation) { st.stream?.getTracks().forEach((t) => t.stop()); st.stream = null; return false; }

  // Absolute, from config: on an injected page location.host is the STORE.
  const ws = new WebSocket(wsUrl("/stt"));
  ws.binaryType = "arraybuffer";
  st.ws = ws;

  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 6000);
    ws.onopen  = () => { clearTimeout(t); resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
  });
  if (mine !== generation) { try { ws.close(); } catch {} st.stream?.getTracks().forEach((t) => t.stop()); st.stream = null; return false; }
  if (!opened) {
    console.warn("[cue] stt socket failed to open");
    st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
    return false;
  }

  let unavailable = false;
  let verdict;
  const decided = new Promise((resolve) => { verdict = resolve; });
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case "cue.ready":
        st.provider = m.provider || "grok";
        verdict(true);
        break;
      case "cue.unavailable":
        unavailable = true;
        console.warn("[cue] server stt unavailable:", m.reason);
        bus.emit("STATE", { sttProvider: "browser", sttError: m.reason });
        verdict(false);
        break;
      case "transcript.created":
        // The server falls back from Grok to ElevenLabs on its own and says so
        // here; the stream is identical either way.
        st.ready = true;
        st.provider = m.provider || "grok";
        bus.emit("STATE", { sttProvider: st.provider });
        console.log(`[cue] ${st.provider} stt live`);
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

  // The server tries Grok, then ElevenLabs, and only then says which one it
  // got. Report failure rather than a live-looking mic that hears nothing, so
  // voice.js falls back to the browser recogniser. A server too old to send a
  // verdict is assumed live after the wait, as before.
  const live = await Promise.race([decided, new Promise((r) => setTimeout(() => r(true), 10000))]);
  if (mine !== generation) { st.stream?.getTracks().forEach((t) => t.stop()); st.stream = null; try { ws.close(); } catch {} return false; }
  if (!live) {
    st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
    try { ws.close(); } catch {}
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

  if (mine !== generation) { stop(); return false; }
  st.running = true;
  bus.emit("STATE", { listening: true, sttProvider: st.provider || "grok" });
  return true;
}

/** Which upstream the server picked: "grok" or "eleven". */
export const provider = () => st.provider || "grok";

/** Release of push-to-talk: cut the utterance now, don't wait out the silence. */
export function finalize() {
  flush(true);
  if (st.ws?.readyState === WebSocket.OPEN) st.ws.send(JSON.stringify({ type: "Finalize" }));
}

/** Cut the audio feed entirely. Debug use only — the speaking path deliberately
 *  does NOT call this, because muting the mic while Cue talks kills barge-in. */
export function setMuted(m) { st.muted = !!m; }

export function stop() {
  generation++;
  st.running = false;
  st.ready = false;
  try { st.node?.disconnect(); st.src?.disconnect(); } catch {}
  try { st.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { st.ctx?.close(); } catch {}
  try { st.ws?.close(); } catch {}
  st.node = null; st.src = null; st.stream = null; st.ctx = null; st.ws = null;
  carry = []; carryLen = 0;
}

export const getMicState = () => ({
  running: st.running, ready: st.ready, muted: st.muted,
  ws: st.ws?.readyState, rate: st.ctx?.sampleRate,
});
