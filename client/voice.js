import { bus } from "./bus.js";
import * as mic from "./mic.js";
import { url } from "./config.js";
import { findWake, stripWake, echoes } from "./speech.js";

// STT mishears the wake word constantly ("q", "queue", "cute"). findWake()
// decides from context: a bare "q" counts at the start of a sentence, a
// sound-alike like "cute" only when a command follows it, and neither counts
// mid-sentence, so "a cute dress" never wakes Cue.

// Once you have said the wake word you get a window to keep talking without
// repeating it. Real conversation is "Cue, is this wool?" ... "does it run
// small?" — not the wake word every single time.
const WAKE_WINDOW_MS = 2 * 60 * 1000;   // say "Hey Cue" once; stays open while you keep talking

// Chrome (and Grok) deliver a final transcript some hundreds of ms AFTER
// speech stops — which is after the user has let go of the key. Reading an
// instantaneous `ptt` flag at that moment always saw false, so every single
// push-to-talk utterance was silently discarded. Arm a window instead.
const PTT_TAIL_MS = 2500;

// Tail after Cue stops talking, for speaker ring-out. It cannot be much longer
// than this: anything the user says during that window is lost, and blanket-
// muting for the whole utterance would make barge-in impossible.
const SELF_HEAR_TAIL_MS = 450;

// Barge-in has to survive the mic hearing our own speakers. getUserMedia's
// echo cancellation does most of the work; this catches what leaks through by
// noticing that the "command" is just a chunk of what Cue is currently saying.
const BARGE_MIN_CHARS = 9;

const state = {
  rec: null, listening: false, speaking: false, provider: "none",
  mutedUntil: 0, pttUntil: 0, wakeUntil: 0,
  calibrating: false, ttsMode: "browser", micError: null, privateMode: false,
  // "Cue, quit" used to release the mic outright — the only way back was the
  // toolbar icon. Paused keeps the mic live and listening for exactly one
  // thing; everything else this module or aura.js would normally do is
  // skipped below, the same way isHalt already bypasses wake-word and
  // private-mode gating so "stop" works no matter what state Cue is in.
  paused: false,
};
let listenGeneration = 0;
let audio = null;
let starting = false;

const now = () => performance.now();
const pttArmed = () => now() < state.pttUntil;

// ── One gate, both transports ───────────────────────────────────────────────
// Grok and the browser recogniser both land here. Intent gating lives in
// exactly one place so the two paths can never drift apart.
//
// Phrases the calibration screens tell the shopper to say. The prompts quote
// these words, so the echo filter treats them as Cue talking to itself, and
// push-to-talk is off for the whole calibration, so the wake word is required
// too. Either one drops "next" and "continue anyway". Accepted here, before
// both gates, and only while a calibration screen is up.
const CAL_DOT = /^(?:next|ready|capture|ok|okay|go|done)\b/;
const CAL_CHOICE = /\b(?:continue|carry on|keep going|proceed|skip|good enough|leave it|fine|try again|again|retry|redo|recalibrat\w*)\b/;

/** Keep listening without the wake word, e.g. while the page is scrolling and
 *  a bare "stop" has to work. */
export function keepAwake(ms = WAKE_WINDOW_MS) {
  state.wakeUntil = Math.max(state.wakeUntil, now() + ms);
}

export function calibrationCommand(text) {
  const n = norm(stripWake(norm(text)));
  if (!n) return null;
  return CAL_DOT.test(n) || CAL_CHOICE.test(n) ? n : null;
}

function isHalt(text) {
  const n = norm(stripWake(norm(text)));
  return /^(?:end|cue end|stop cue|pause cue|exit|quit|stop|go away|shut down|turn(?: yourself)? off|disable)(?: cue)?$/.test(n);
}

// The opposite of isHalt, same shape: stripWake so "Cue, start" and a bare
// "start" both work — a paused Cue is listening for nothing else, so a bare
// word is exactly as safe here as it is for "stop".
function isResume(text) {
  const n = norm(stripWake(norm(text)));
  return /^(?:start|resume|wake up|come back|i'?m back)(?: cue)?$/.test(n);
}

function handleTranscript(text, final, alternatives = null) {
  text = (text || "").trim();
  // "Cue, end" stops immediately, including mid-calibration and private payment.
  if (text && (isHalt(text) || (alternatives || []).some(isHalt))) {
    bus.emit("STOP");
    return;
  }
  // While paused, this is the only thing being listened for — checked before
  // privateMode/calibrating the same way isHalt is, so it works regardless
  // of whatever state Cue was in when it was paused.
  if (state.paused) {
    if (final && (isResume(text) || (alternatives || []).some(isResume))) {
      state.paused = false;
      bus.emit("RESUME");
    }
    return;
  }
  if (state.privateMode) return;
  if (!text) return;

  if (state.calibrating) {
    if (!final) return;
    const cands = alternatives?.length ? alternatives : [text];
    let cmd = null;
    for (const alt of cands) {
      cmd = calibrationCommand(alt);
      if (cmd) break;
    }
    if (!cmd) return;
    // Retire the prompt before the verdict is spoken, or the two play together.
    speakTicket++;
    stopSpeaking();
    bus.emit("UTTERANCE", { text: cmd, final: true });
    return;
  }

  let barged = false;
  if (state.speaking) {
    // Our own voice coming back through the mic is not a command, and it is
    // not barge-in either. The old code took any 3+ characters as barge-in, so
    // Cue reliably interrupted itself one syllable into every sentence.
    if (isEcho(text)) return;
    // A real interruption is a real phrase, not a leaked fragment.
    if (!final && text.length < BARGE_MIN_CHARS) return;
    stopSpeaking();
    barged = true;
  }

  // Short tail for the speakers ringing out after we stop — but never applied
  // to the utterance that just interrupted us, or interrupting Cue would
  // reliably swallow the command you interrupted it with.
  if (!barged && now() < state.mutedUntil) return;

  if (!final) { bus.emit("UTTERANCE", { text, final: false }); return; }

  // Push-to-talk, or still inside the wake window: take it verbatim.
  if (pttArmed() || now() < state.wakeUntil) {
    state.wakeUntil = now() + WAKE_WINDOW_MS;     // keep the conversation open
    bus.emit("UTTERANCE", { text: stripWake(text), final: true });
    return;
  }

  // Otherwise it has to be addressed to us. Check every alternative — the wake
  // word is one syllable and is often only right in the second guess.
  const cands = alternatives?.length ? alternatives : [text];
  let hit = null;
  for (const alt of cands) {
    hit = findWake(alt || "");
    if (hit) break;
  }
  if (!hit) return;

  const rest = hit.rest;
  state.wakeUntil = now() + WAKE_WINDOW_MS;
  if (rest) bus.emit("UTTERANCE", { text: rest, final: true });
  else bus.emit("STATE", { awake: true });        // just the name: open the window
}

// Is this transcript just Cue's own voice bouncing off the speakers?
let speakingText = "";
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// A turn often speaks twice in a row — the agent's line, then the page's own
// ("Opening your cart now." then "Opening Cart, shift, option, c."). The mic
// hears them as one blurred transcript that matches neither line on its own,
// so remember the last few, not just the one playing.
let spokenRecently = [];
const ECHO_MEMORY_MS = 6000;
const ECHO_TAIL_MS = 1200;

function rememberSpoken(text) {
  const t = norm(text);
  if (!t) return;
  spokenRecently = [...spokenRecently, { t, at: now() }]
    .filter((s) => now() - s.at < ECHO_MEMORY_MS)
    .slice(-4);
}

function isEcho(text) {
  if (!norm(text)) return Boolean(speakingText);
  // Consult memory only while we are talking or just after. Beyond that the
  // words are the shopper's, and treating them as echo would eat real speech:
  // "open my cart" right after Cue mentions the cart is a real command.
  const listening = state.speaking || now() < state.mutedUntil + ECHO_TAIL_MS;
  return echoes(text, [speakingText, ...(listening ? spokenRecently.map((s) => s.t) : [])]);
}

bus.on("STT", ({ text, final }) => handleTranscript(text, final));

// Calibration owns the space bar while it is up.
bus.on("STATE", (s) => {
  if (s.calibrating !== undefined) state.calibrating = s.calibrating;
});

// ── Mic permission ──────────────────────────────────────────────────────────
export async function requestMic() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());        // we only needed the grant
    return true;
  } catch (e) {
    console.warn("[cue] mic permission denied:", e.name);
    state.micError = e.name;
    return false;
  }
}

// ── Start listening ─────────────────────────────────────────────────────────
export async function startListening() {
  if (state.privateMode) return false;
  const generation = ++listenGeneration;
  bindPushToTalk();

  // Server-side recognition first: Grok, or ElevenLabs if the server had to
  // fall back. Both beat the browser in a loud room and both support
  // push-to-talk finalisation. state.provider stays "grok" for either, since
  // it means "the server stream", which is what finalize() depends on.
  let health = null;
  try { health = await (await fetch(url("/health"))).json(); } catch {}
  if (state.privateMode || generation !== listenGeneration) return false;
  if (health?.stt?.ready) {
    if (await mic.start()) {
      if (state.privateMode || generation !== listenGeneration) { mic.stop(); return false; }
      state.listening = true; state.provider = "grok";
      bus.emit("STATE", { listening: true, sttProvider: mic.provider() });
      return true;
    }
    console.warn("[cue] server stt failed to start — falling back to the browser");
  }
  if (state.privateMode || generation !== listenGeneration) return false;
  return startBrowserStt();
}

function startBrowserStt() {
  if (state.privateMode) return false;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    // Brave ships the constructor but no speech service, and some builds ship
    // neither. Either way there is no fallback there — Grok has to be working.
    console.warn("[cue] no SpeechRecognition in this browser. Fix XAI_API_KEY " +
                 "so Grok STT runs, or drive it with cue.say('...').");
    state.listening = false; state.provider = "none";
    bus.emit("STATE", { listening: false, sttProvider: "none" });
    return false;
  }
  const rec = new SR();
  rec.continuous = true; rec.interimResults = true; rec.lang = "en-US";
  rec.maxAlternatives = 3;

  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const alts = [];
      for (let k = 0; k < r.length; k++) alts.push((r[k]?.transcript ?? "").trim());
      handleTranscript(alts[0], r.isFinal, alts);
    }
  };

  // A denied or unavailable mic is permanent — retrying it spins the CPU.
  const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);
  rec.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    console.warn("[cue] stt", e.error);
    if (FATAL.has(e.error)) {
      state.listening = false;
      state.micError = e.error;
      bus.emit("STATE", { listening: false, micError: e.error });
      console.warn("[cue] mic unavailable — cue.say('...') still drives everything");
    }
  };

  // Chrome ends recognition every ~60s; restart, but back off so a flapping
  // mic can never become a hot loop.
  let backoff = 250;
  rec.onend = () => {
    if (!state.listening || state.privateMode) return;
    setTimeout(() => {
      if (!state.listening || state.privateMode || starting) return;
      starting = true;
      try { rec.start(); backoff = 250; }
      catch (err) { if (!/already/i.test(err.message)) backoff = Math.min(backoff * 2, 5000); }
      finally { starting = false; }
    }, backoff);
  };

  try { rec.start(); } catch (err) { console.warn("[cue] rec.start", err.message); }
  state.rec = rec; state.listening = true; state.provider = "browser";
  bus.emit("STATE", { listening: true, sttProvider: "browser" });
  return true;
}

// ── Push to talk ────────────────────────────────────────────────────────────
// Hold Space to skip the wake word. Hackathon floors are loud.
let ptBound = false;
function bindPushToTalk() {
  if (ptBound) return;
  ptBound = true;
  addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat || state.calibrating || state.privateMode) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target?.tagName)) return;
    e.preventDefault();
    state.pttUntil = Infinity;
    state.wakeUntil = 0;
    bus.emit("STATE", { ptt: true });
  });
  addEventListener("keyup", (e) => {
    if (e.code !== "Space" || state.calibrating || state.privateMode) return;
    // Arm a tail rather than closing immediately — the final transcript has not
    // arrived yet at the moment the key comes up.
    state.pttUntil = now() + PTT_TAIL_MS;
    if (state.provider === "grok") mic.finalize();   // cut it now, don't wait
    bus.emit("STATE", { ptt: false });
  });
}

// Private payment turns the mic and the speaker off until the shopper
// explicitly resumes. Card digits must not be spoken or captured as commands.
export async function enterPrivateMode() {
  if (state.privateMode) return true;
  state.privateMode = true;
  listenGeneration++;
  state.listening = false;
  state.provider = "none";
  state.pttUntil = 0;
  state.wakeUntil = 0;
  speakTicket++;
  heldLine = null;
  stopSpeaking();
  try { state.rec?.abort?.(); } catch {}
  state.rec = null;
  mic.stop();
  bus.emit("STATE", { listening: false, sttProvider: "none", ptt: false, privateMode: true });
  return true;
}

export function exitPrivateMode() {
  state.privateMode = false;
  bus.emit("STATE", { privateMode: false });
}

export const isPrivateMode = () => state.privateMode;

// aura.js flips this on when Cue pauses (mic stays live; see handleTranscript
// above for what "paused" actually gates) and off again once RESUME fires.
export function setPaused(on) {
  state.paused = !!on;
  bus.emit("STATE", { paused: state.paused });
}
export const isPaused = () => state.paused;

// ── Autoplay unlock ─────────────────────────────────────────────────────────
// Browsers refuse to play audio before the user has interacted with the page,
// and Brave is stricter than Chrome about it. The first line Cue says ("Cue is
// ready…") therefore lands before any gesture and is silently dropped — the
// demo opens with nothing audible. Hold it and speak it on the first gesture.
let audioUnlocked = false;
let heldLine = null;

function unlock() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try { speechSynthesis.resume(); } catch {}
  if (heldLine) { const t = heldLine; heldLine = null; speak(t); }
}
for (const ev of ["pointerdown", "keydown", "touchstart"]) {
  addEventListener(ev, unlock, { once: false, passive: true });
}

// ── Speech out ──────────────────────────────────────────────────────────────
export function stopSpeaking() {
  try { speechSynthesis.cancel(); } catch {}
  if (audio) { audio.pause(); audio = null; }
  state.speaking = false;
  speakingText = "";
  state.mutedUntil = now() + SELF_HEAR_TAIL_MS;
}

export function stopListening() {
  state.listening = false;
  state.provider = "none";
  try { state.rec?.abort(); } catch {}
  state.rec = null;
  mic.stop();
  stopSpeaking();
  bus.emit("STATE", { listening: false, sttProvider: "none" });
}

// Every call takes a ticket. stopSpeaking() cancels whatever is AUDIBLE, but a
// call that is still fetching its audio has nothing to cancel yet — so two
// SAYs landing close together (the calibration verdict and "Cue is ready", say)
// both finished their fetch and both played, on top of each other. After every
// await, a call that is no longer the current one gives up.
let speakTicket = 0;

export async function speak(text) {
  if (!text || state.privateMode) return;
  const mine = ++speakTicket;
  const current = () => mine === speakTicket;
  stopSpeaking();
  speakTicket = mine;            // stopSpeaking must not invalidate our own ticket
  state.speaking = true;
  // What we are saying, so the echo check can recognise it coming back.
  // We deliberately do NOT mute the mic here: barge-in has to keep working.
  speakingText = text;
  rememberSpoken(text);
  try {
    const res = await fetch(url("/tts?text=" + encodeURIComponent(text)));
    if (!current() || state.privateMode) return;  // superseded, or payment mode started mid-fetch
    const ct = res.headers.get("content-type") || "";
    if (ct.startsWith("audio/")) {
      const url = URL.createObjectURL(await res.blob());
      if (!current()) { URL.revokeObjectURL(url); return; }
      audio = new Audio(url);
      state.ttsMode = res.headers.get("x-cue-tts") || "eleven";
      bus.emit("STATE", { ttsMode: state.ttsMode });
      let blocked = false;
      await new Promise((r) => {
        audio.onended = audio.onerror = r;
        audio.play().catch((err) => {
          // NotAllowedError = no user gesture yet. Hold the line, don't lose it.
          if (err?.name === "NotAllowedError" && !audioUnlocked) {
            blocked = true;
            heldLine = text;
            console.warn("[cue] audio blocked until first interaction — will speak on click/keypress");
          }
          r();
        });
      });
      URL.revokeObjectURL(url);
      if (blocked) { state.speaking = false; speakingText = ""; return; }
    } else {
      const body = await res.json().catch(() => ({}));
      if (!current()) return;
      state.ttsMode = "browser";
      bus.emit("STATE", { ttsMode: "browser" });
      await browserSpeak(body.text || text);       // server hands back spoken form
    }
  } catch (e) {
    console.warn("[cue] tts fell back to browser:", e.message);
    await browserSpeak(text);
  }
  if (!current()) return;          // a newer line owns the state now
  state.speaking = false;
  speakingText = "";
  state.mutedUntil = now() + SELF_HEAR_TAIL_MS;
}

// ── Browser voice (fallback only) ───────────────────────────────────────────
// getVoices() is populated asynchronously. The old code called it once at speak
// time, usually got [], picked nothing, and fell through to the default robot.
let voicePromise = null;
function voices() {
  if (voicePromise) return voicePromise;
  voicePromise = new Promise((resolve) => {
    const got = () => {
      const v = speechSynthesis.getVoices();
      if (v.length) { resolve(v); return true; }
      return false;
    };
    if (got()) return;
    speechSynthesis.addEventListener("voiceschanged", got, { once: true });
    setTimeout(() => resolve(speechSynthesis.getVoices()), 1200);
  });
  return voicePromise;
}

// Best-first. The Premium/Enhanced macOS voices and Google's network voices are
// dramatically less robotic than Samantha, which was the old first choice.
const VOICE_RANK = [
  /Ava.*Premium/i, /Zoe.*Premium/i, /Allison.*Premium/i, /Samantha.*Premium/i,
  /Google US English/i, /Microsoft (Aria|Jenny|Ava)/i,
  /\(Enhanced\)/i, /Natural/i, /Samantha/i, /Daniel/i,
];

let chosenVoice = null;
async function pickVoice() {
  if (chosenVoice !== null) return chosenVoice;
  const all = (await voices()).filter((v) => /^en(-|_|$)/i.test(v.lang));
  for (const rx of VOICE_RANK) {
    const hit = all.find((v) => rx.test(v.name));
    if (hit) { chosenVoice = hit; break; }
  }
  if (!chosenVoice) chosenVoice = all[0] ?? false;
  if (chosenVoice) console.log("[cue] browser voice:", chosenVoice.name);
  return chosenVoice;
}

function browserSpeak(text) {
  return new Promise((done) => {
    pickVoice().then((v) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.pitch = 1.0; u.volume = 1.0;
      if (v) u.voice = v;
      u.onend = u.onerror = done;
      speechSynthesis.speak(u);
    });
  });
}

// Warm the voice list early so the very first line is not the robot.
if (typeof speechSynthesis !== "undefined") pickVoice();

export const getVoiceState = () => ({
  ...state, rec: undefined,
  pttArmed: pttArmed(), awake: now() < state.wakeUntil, mic: mic.getMicState(),
});
