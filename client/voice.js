import { bus } from "./bus.js";

const WAKE = /\b(aura|ora|aurora)\b/i;   // STT mishears "aura" constantly; accept near-misses
const SELF_HEAR_GUARD_MS = 300;

const state = { rec: null, listening: false, speaking: false, mutedUntil: 0, ptt: false, ttsMode: "browser" };
let audio = null;

// ── Speech in ───────────────────────────────────────────────────────────────
export function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { console.warn("[aura] no SpeechRecognition; use push-to-type"); return false; }
  const rec = new SR();
  rec.continuous = true; rec.interimResults = true; rec.lang = "en-US";

  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0].transcript.trim();
      if (!text) continue;

      // Barge-in: the moment the user talks over Aura, Aura shuts up.
      if (state.speaking && text.length > 2) stopSpeaking();
      // Don't let the mic transcribe our own TTS.
      if (performance.now() < state.mutedUntil) continue;

      if (!r.isFinal) { bus.emit("UTTERANCE", { text, final: false }); continue; }

      if (state.ptt) { bus.emit("UTTERANCE", { text, final: true }); continue; }
      const m = text.match(WAKE);
      if (!m) continue;                                   // no wake word, ignore
      const rest = text.slice(m.index + m[0].length).replace(/^[,\s]+/, "").trim();
      if (rest) bus.emit("UTTERANCE", { text: rest, final: true });
    }
  };
  // A denied or unavailable mic is permanent — retrying it spins the CPU forever.
  const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);
  rec.onerror = (e) => {
    if (e.error === "no-speech") return;
    console.warn("[aura] stt", e.error);
    if (FATAL.has(e.error)) {
      state.listening = false;
      bus.emit("STATE", { listening: false, micError: e.error });
      console.warn("[aura] mic unavailable — push-to-type via aura.say('...') still works");
    }
  };
  // Chrome ends recognition every ~60s; restart, but back off so a flapping
  // mic can never become a hot loop.
  let backoff = 250;
  rec.onend = () => {
    if (!state.listening) return;
    setTimeout(() => {
      if (!state.listening) return;
      try { rec.start(); backoff = 250; }
      catch { backoff = Math.min(backoff * 2, 5000); }
    }, backoff);
  };

  rec.start();
  state.rec = rec; state.listening = true;
  bus.emit("STATE", { listening: true });

  // Push-to-talk: hold Space to skip the wake word. Hackathon floors are loud.
  addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat && !state.ptt) { e.preventDefault(); state.ptt = true; bus.emit("STATE", { ptt: true }); }
  });
  addEventListener("keyup", (e) => {
    if (e.code === "Space") { state.ptt = false; bus.emit("STATE", { ptt: false }); }
  });
  return true;
}

// ── Speech out ──────────────────────────────────────────────────────────────
export function stopSpeaking() {
  try { speechSynthesis.cancel(); } catch {}
  if (audio) { audio.pause(); audio = null; }
  state.speaking = false;
}

export async function speak(text) {
  if (!text) return;
  stopSpeaking();
  state.speaking = true;
  try {
    const res = await fetch("/tts?text=" + encodeURIComponent(text));
    const ct = res.headers.get("content-type") || "";
    if (ct.startsWith("audio/")) {
      const url = URL.createObjectURL(await res.blob());
      audio = new Audio(url);
      state.ttsMode = res.headers.get("x-aura-tts") || "eleven";
      await new Promise((r) => { audio.onended = audio.onerror = r; audio.play().catch(r); });
      URL.revokeObjectURL(url);
    } else {
      state.ttsMode = "browser";
      await browserSpeak(text);
    }
  } catch (e) {
    console.warn("[aura] tts fell back to browser:", e.message);
    await browserSpeak(text);
  }
  state.speaking = false;
  state.mutedUntil = performance.now() + SELF_HEAR_GUARD_MS;
}

function browserSpeak(text) {
  return new Promise((done) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 1.0;
    const v = speechSynthesis.getVoices().find(v => /Samantha|Google US English|Daniel/.test(v.name));
    if (v) u.voice = v;
    u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  });
}

export const getVoiceState = () => ({ ...state, rec: undefined });
