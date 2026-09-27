// Speech-to-text gets short words wrong in predictable ways: "q" for "Cue",
// "clique" for "click", "card" for "Cart". Correct them against what could
// actually be meant — the page's own controls and fields — and leave the text
// alone when two readings are close. No DOM access: node tests import this.

export function norm(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

// Coarse sound-alike key. Voiced and unvoiced pairs collapse (d/t, b/p, g/k,
// v/f, z/s) because those are exactly what recognisers swap.
export function soundKey(word) {
  let w = String(word ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w.replace(/^kn/, "n").replace(/^wr/, "r").replace(/^wh/, "w")
    .replace(/x/g, "ks").replace(/ph/g, "f").replace(/ck/g, "k").replace(/gh/g, "")
    .replace(/[cs]h/g, "x").replace(/c(?=[eiy])/g, "s").replace(/g(?=[eiy])/g, "j")
    .replace(/[cq]/g, "k").replace(/d/g, "t").replace(/b/g, "p").replace(/g/g, "k")
    .replace(/v/g, "f").replace(/z/g, "s");
  const first = /[aeiouy]/.test(w[0]) ? "a" : w[0];
  return (first + w.slice(1).replace(/[aeiouywh]/g, "")).replace(/(.)\1+/g, "$1");
}

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const ratio = (a, b) => (a || b ? 1 - lev(a, b) / Math.max(a.length, b.length) : 0);

/** 0..1: how likely one spoken word was heard as the other. */
export function wordSimilarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const spelled = ratio(a, b);
  const ka = soundKey(a), kb = soundKey(b);
  // One-letter keys ("k") match half the dictionary; trust them less.
  const weight = Math.min(ka.length, kb.length) >= 2 ? 0.9 : 0.5;
  return Math.max(spelled, weight * ratio(ka, kb));
}

// "and" is how "Account & Lists" is spoken.
const FILLER = new Set(["the", "a", "an", "and", "my", "on", "to", "button", "link", "tab", "page", "please"]);
const content = (s) => norm(s).split(" ").filter((w) => w && !FILLER.has(w));

/** 0..1: how well a spoken phrase names a control label. */
export function phraseScore(phrase, name) {
  const p = content(phrase), n = content(name);
  if (!p.length || !n.length) return 0;
  const per = p.map((w) => Math.max(...n.map((x) => wordSimilarity(w, x))));
  const avg = per.reduce((s, x) => s + x, 0) / per.length;
  const covered = n.filter((x) => p.some((w) => wordSimilarity(w, x) >= 0.8)).length / n.length;
  const tokens = 0.75 * avg + 0.25 * covered;
  // "desk tops" and "desktops" are one word to the ear.
  const joined = ratio(p.join(""), n.join(""));
  return Math.max(tokens, joined);
}

/**
 * Best label for a spoken phrase, or null. A near tie is not a match: clicking
 * the wrong one of two similar buttons is worse than asking.
 */
export function bestMatch(phrase, names, { min = 0.78, margin = 0.08 } = {}) {
  const scored = [];
  (names ?? []).forEach((name, index) => {
    if (!name) return;
    scored.push({ name, index, score: phraseScore(phrase, name) });
  });
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score < min) return null;
  if (next && norm(next.name) !== norm(best.name) && best.score - next.score < margin) return null;
  return best;
}

// ── Wake word ───────────────────────────────────────────────────────────────
// Full words that only ever mean us, anywhere in the sentence.
const STRONG = new Set(["cue", "queue", "queues", "kew", "kyu", "aura", "aurora"]);
// Too short to trust mid-sentence ("a q-tip"), fine as the first word.
const LEADING = new Set(["q", "cu", "coo", "que", "ku", "ora"]);
// Real words the recogniser hears for "Cue". Accepted only when what follows
// is plainly a command — that context is what separates "cute, open the bag"
// from "cute dress".
const SOUNDALIKE = new Set(["cute", "cool", "hue", "hugh", "quick", "coup", "cues", "kiu", "kyoo"]);
const OPENERS = new Set(["hey", "hi", "ok", "okay", "so", "um", "uh", "yo"]);

export const COMMAND_WORDS = new Set([
  "click", "tap", "press", "hit", "open", "select", "choose", "pick", "go", "take", "show",
  "search", "find", "look", "type", "enter", "write", "submit", "add", "remove", "delete",
  "scroll", "check", "checkout", "read", "what", "whats", "is", "are", "does", "do", "how",
  "can", "could", "would", "please", "tell", "compare", "describe", "yes", "yeah", "no",
  "next", "cancel", "end", "stop", "buy", "get", "put", "where", "which", "recalibrate",
  "calibrate", "help", "number", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "back", "forward", "empty", "clear",
]);

function tokens(text) {
  return [...String(text ?? "").matchAll(/[A-Za-z0-9']+/g)]
    .map((m) => ({ word: m[0].toLowerCase().replace(/'s$/, ""), end: m.index + m[0].length }));
}

const restAfter = (text, end) => text.slice(end).replace(/^[,.!?:;\s]+/, "").trim();

function looksLikeCommand(rest) {
  const first = norm(rest).split(" ")[0];
  if (!first) return false;
  if (COMMAND_WORDS.has(first) || /^\d+$/.test(first)) return true;
  return correctVerb(rest).changed;
}

/**
 * Was this addressed to Cue? Returns { rest } (possibly empty for a bare
 * "Cue") or null.
 */
export function findWake(text) {
  const toks = tokens(text);
  let i = 0;
  while (i < toks.length && i < 2 && OPENERS.has(toks[i].word)) i++;
  const lead = toks[i];
  if (lead) {
    const rest = restAfter(text, lead.end);
    if (STRONG.has(lead.word) || LEADING.has(lead.word)) return { rest, how: "leading" };
    // "go" keys to "k" too, and "go to checkout" is not "Cue, to checkout".
    const soundsLike = !COMMAND_WORDS.has(lead.word) &&
      (SOUNDALIKE.has(lead.word) || (soundKey(lead.word) === "k" && lead.word.length <= 5));
    if (soundsLike && rest && looksLikeCommand(rest)) return { rest, how: "soundalike" };
  }
  for (const t of toks) {
    if (STRONG.has(t.word)) return { rest: restAfter(text, t.end), how: "anywhere" };
  }
  return null;
}

/** Drop a leading wake word that push-to-talk or the open window picked up. */
export function stripWake(text) {
  const w = findWake(text);
  if (w && w.how !== "anywhere" && w.rest) return w.rest;
  return text;
}

export const isWakeOnly = (text) => {
  const w = findWake(text);
  return !!w && !w.rest;
};

// ── Command verbs ───────────────────────────────────────────────────────────
// Each verb is corrected only when the rest of the sentence fits it. "Oven
// mitts" is never turned into "open mitts" unless the page has a Mitts button.
const CLICKY = ["click", "open", "select", "press", "tap"];

export function correctVerb(text, { controls = [], fields = [] } = {}) {
  const original = String(text ?? "").trim();
  const m = original.match(/^([A-Za-z']+)([\s,]+)(.*)$/);
  if (!m) return { text: original, changed: false };
  const [, head, gap, tail] = m;
  const first = head.toLowerCase();
  if (COMMAND_WORDS.has(first) || first.length < 3) return { text: original, changed: false };
  const next = norm(tail).split(" ")[0] ?? "";
  const target = tail.replace(/^(?:on|the|my)\s+/i, "");

  const options = [
    ...CLICKY.map((verb) => ({ verb, fits: () => !!bestMatch(target, controls) })),
    { verb: "search", fits: () => next === "for" },
    { verb: "scroll", fits: () => /^(?:up|down|top|bottom|left|right)$/.test(next) },
    { verb: "type", fits: () => /\b(?:in|into)\s+(?:the\s+)?\S+/i.test(tail) && fields.length > 0 },
  ];
  let best = null;
  for (const o of options) {
    const s = wordSimilarity(first, o.verb);
    const floor = o.verb === "search" ? 0.6 : 0.7;
    if (s >= floor && (!best || s > best.s) && o.fits()) best = { ...o, s };
  }
  if (!best) return { text: original, changed: false };
  return { text: `${best.verb}${gap}${tail}`, changed: true };
}

/** Everything the page can do to a transcript before it is sent on. */
export function correctUtterance(text, vocab = {}) {
  const stripped = stripWake(text);
  const verb = correctVerb(stripped, vocab);
  return { text: verb.text, changed: verb.text !== String(text ?? "").trim() };
}
