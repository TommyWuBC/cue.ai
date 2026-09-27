// Which item an utterance is about. Pure, no DOM: tests import this directly.
//
// This is where gaze earns its place or gets out of the way. Webcam gaze is
// off by 100-300px, so it must never outrank what the words and the
// conversation already settle; it is consulted only where talking alone would
// have had to ask "which one?". The order:
//
//   1. The words name exactly one item            -> that item      ("named")
//   2. The words name 2-3 items                   -> the one the eyes favour
//                                                    among them, else ask ("named+gaze")
//   3. "the one I was looking at"                 -> what this visit studied ("gaze")
//   4. "this" / "this one" / "here" (pointing)    -> the page's own product, else a
//                                                    clear gaze leader, else the
//                                                    conversation ("page" / "gaze")
//   5. "it" / "that" / no pointing word           -> the conversation, else the
//                                                    page's own product, else a clear
//                                                    gaze leader ("conversation" / ...)
//
// Whenever gaze decided, the reply names the item, so a wrong guess costs one
// "no, the other one" rather than a wrong action. And when the eyes are split
// between two items, Cue asks by name, most likely first.

const PAST_GAZE = /\b(?:the one i (?:was|were) looking at|i was looking at|the one i looked at|the one i was just looking at)\b/i;
// "These", "both", "compare them": two items, not one.
const PLURAL = /\b(?:these|these two|those two|both|the two|compare them|compare these|between them)\b/i;
const POINTING = /\b(?:this|this one|these|here|the one i'?m looking at|the one i am looking at|what i'?m looking at)\b/i;
const ANAPHOR = /\b(?:it|its|it's|that|that one|them|the same one)\b/i;
// Utterances that are about an item at all. Navigation ("scroll down",
// "search for boots") is not, and must never pick one up from the eyes.
const ABOUT_ITEM = /\b(?:add|bag|cart|basket|buy|order|size|colou?r|price|cost|how much|cheap|expensive|tell me|describe|about|material|made|fabric|warm|fit|review|rating|stars|small|medium|large|x?xl|xs|this|that|it|these|them|one|compare|better|worth|look like|details?)\b/i;
const NAVIGATION = /^(?:please |can you |could you |cue )*(?:scroll|go back|back|go forward|forward|page |search|find|look for|look up|open (?:the )?(?:cart|bag|menu)|stop|close|cancel|no\b|yes\b|recalibrate|calibrate)/i;

// "This page", "these results": the page, not an item on it.
const PAGE_WORDS = /\b(?:this|these|the) (?:page|site|store|shop|list|screen|search|results?|category|section)\b/gi;
// Choosing across the page ("which is cheapest", "the best one", "show me
// the warmest"): the agent reads the whole page for that. The eyes are not a
// hint about which item is cheapest.
const SELECTION = /^(?:which|what(?:'s| is| are)? the \w+est)\b|\b\w{3,}est\b|\b(?:most|least|best|any|all of|every|how many|show me|recommend|suggest)\b/i;

// A gaze pick has to be clearly ahead: most of the attention, and well
// ahead of the runner-up. Two items within this ratio are "too close to call".
const LEAD_SHARE = 0.5;
const LEAD_RATIO = 1.8;
const STRONG_SHARE = 0.6;
const ASK_MIN_EACH = 0.22;

export const talksAboutItem = (text) => ABOUT_ITEM.test(text) && !NAVIGATION.test(text.trim());

const productRows = (rows, ids) => (rows || []).filter((r) => r && r.id != null
  && (!ids || ids.includes(r.id)) && (r.kind == null || r.kind === "product"));

/**
 * Shares among a set of candidate ids, strongest first: [{ id, share, raw }].
 * The moment speech began (~0.5 s of looking) is blended with the last few
 * seconds: one is what "this" points at, the other is steady enough to trust
 * at webcam noise. A steady look wins clearly; a fresh glance that the last
 * few seconds disagree with comes out close, and close means ask.
 */
export function sharesAmong(attention, ids = null) {
  if (!attention) return [];
  const view = (key) => {
    const rows = productRows(attention[key], ids);
    const sum = rows.reduce((s, r) => s + (r.share || 0), 0);
    return rows.length && sum > 0.05 ? { rows, sum } : null;
  };
  const onset = view("at_speech"), recent = view("recent");
  const use = onset && recent ? [[onset, 0.5], [recent, 0.5]]
    : [[onset ?? recent ?? view("now"), 1]];
  if (!use[0][0]) return [];
  const out = new Map();
  for (const [v, w] of use) {
    for (const r of v.rows) {
      const row = out.get(r.id) ?? { id: r.id, share: 0, raw: 0 };
      row.share += w * (r.share / v.sum);
      row.raw += w * r.share;
      out.set(r.id, row);
    }
  }
  return [...out.values()].sort((a, b) => b.share - a.share);
}

/**
 * The two items the eyes have been going between over the last few seconds:
 * both with a real share, together most of the attention. [idA, idB] or null.
 */
export function gazePair(attention) {
  const rows = (attention?.recent || []).filter((r) => r && r.id != null && (r.kind == null || r.kind === "product"));
  const sum = rows.reduce((s, r) => s + (r.share || 0), 0);
  if (rows.length < 2 || sum <= 0) return null;
  const [a, b] = [...rows].sort((x, y) => y.share - x.share).map((r) => ({ id: r.id, share: r.share / sum }));
  return a.share >= 0.2 && b.share >= 0.2 && a.share + b.share >= 0.6 ? [a.id, b.id] : null;
}

/** A clear gaze leader among ids (or all products), or a pair too close to call. */
export function gazePick(attention, ids = null, { strong = false } = {}) {
  const rows = sharesAmong(attention, ids);
  if (!rows.length) return { id: null, pair: null };
  const [a, b] = rows;
  // Without a candidate list the shares are over everything seen, so ask for
  // real mass too: a trickle on one card is not attention.
  const need = strong ? STRONG_SHARE : LEAD_SHARE;
  const mass = ids ? 1 : (a.raw ?? a.share);
  if (a.share >= need && mass >= need * 0.8 && (!b || a.share >= b.share * LEAD_RATIO)) return { id: a.id, pair: null };
  if (b && a.share >= ASK_MIN_EACH && b.share >= ASK_MIN_EACH) return { id: null, pair: [a.id, b.id] };
  return { id: null, pair: null };
}

/**
 * @param {object} p
 * @param {string} p.text        what they said (already corrected)
 * @param {Array}  p.hits        products the words name (matchCandidates), [{ id, title, ... }]
 * @param {object} p.discussed   the item the conversation is about, or null
 * @param {object} p.pageItem    the product this page is about (a product page), or null
 * @param {object} p.attention   gaze.getAttention() or null when gaze is off
 * @param {Array}  p.products    products Cue can see, [{ id, title, ... }]
 * @returns {{ item: object|null, how: string|null, ask: object[]|null, pair?: object[] }}
 */
export function resolveReferent({ text, hits = [], discussed = null, pageItem = null,
  pageVisible = true, attention = null, products = [] }) {
  text = String(text || "").replace(PAGE_WORDS, "the page");
  const byId = new Map(products.filter(Boolean).map((p) => [p.id, p]));
  for (const h of hits) if (h?.id != null && !byId.has(h.id)) byId.set(h.id, h);
  const found = (id) => (id == null ? null : byId.get(id) ?? null);
  const none = { item: null, how: null, ask: null };

  // 1-2. The words named something.
  if (hits.length === 1) return { item: hits[0], how: "named", ask: null };
  if (hits.length > 1) {
    // "tell me more about it" right after naming one is about that one.
    if (discussed && ANAPHOR.test(text) && hits.some((h) => h.id === discussed.id)) {
      return { item: discussed, how: "conversation", ask: null };
    }
    const ids = hits.map((h) => h.id);
    const pick = gazePick(attention, ids);
    if (pick.id != null) return { item: found(pick.id), how: "named+gaze", ask: null };
    // Ask, likeliest first when the eyes lean at all.
    const order = sharesAmong(attention, ids).map((r) => r.id);
    const ranked = [...hits].sort((x, y) => {
      const ix = order.indexOf(x.id), iy = order.indexOf(y.id);
      return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
    });
    return { item: null, how: null, ask: ranked.slice(0, 3) };
  }

  if (!talksAboutItem(text)) return none;

  // "Compare these two": the pair the eyes went between. Named items and
  // the conversation are the agent's to pair up; this only fills the gap.
  if (PLURAL.test(text)) {
    const ids = gazePair(attention);
    const pair = ids?.map(found).filter(Boolean);
    return pair?.length === 2 ? { item: null, how: "gaze", ask: null, pair } : none;
  }

  // 3. "The one I was looking at": what this visit lingered on.
  if (PAST_GAZE.test(text)) {
    const studied = (attention?.studied || []).find((r) => byId.has(r.id));
    if (studied) return { item: found(studied.id), how: "gaze", ask: null };
    return discussed ? { item: discussed, how: "conversation", ask: null } : none;
  }

  // "Which is the cheapest?": the words ask the agent to choose; neither the
  // eyes nor a default item should answer it. The conversation still stands.
  // ("here" in "the cheapest one here" is the page, not a pointing finger.)
  const bare = text.replace(/\b(?:on |in )?here\b/gi, " ");
  if (SELECTION.test(text) && !POINTING.test(bare) && !ANAPHOR.test(bare)) return none;

  const pointing = POINTING.test(text);
  if (pointing) {
    // A strong look at something else beats the conversation: "this" points.
    const pick = gazePick(attention, null, { strong: Boolean(discussed) || Boolean(pageItem) });
    // 4. "This" on a product page is that page's product, unless they have
    // scrolled away from it and are clearly looking at something else.
    if (pageItem && (pageVisible || pick.id == null || !found(pick.id))) {
      return { item: pageItem, how: "page", ask: null };
    }
    if (pick.id != null && found(pick.id)) {
      return { item: found(pick.id), how: pick.id === discussed?.id ? "conversation" : "gaze", ask: null };
    }
    if (discussed) return { item: discussed, how: "conversation", ask: null };
    if (pick.pair) {
      const pair = pick.pair.map(found).filter(Boolean);
      if (pair.length === 2) return { item: null, how: null, ask: pair };
    }
    return none;
  }

  // 5. "It", "that", or nothing pointing at all: the conversation leads.
  if (discussed) return { item: discussed, how: "conversation", ask: null };
  if (pageItem) return { item: pageItem, how: "page", ask: null };
  const pick = gazePick(attention);
  if (pick.id != null && found(pick.id)) return { item: found(pick.id), how: "gaze", ask: null };
  return none;
}

/**
 * The answer to "the Wool Coat or the Puffer Jacket?". Accepts a name, an
 * ordinal ("the first", "the second one", "the other one"), or "that one"
 * with the eyes on one of them. Returns the chosen option or null.
 */
export function answerWhich(text, options, attention = null, match = null) {
  const t = String(text || "").toLowerCase();
  if (!options?.length) return null;
  const named = match ? match(text, options) : [];
  if (named.length === 1) return named[0];
  if (/\b(?:first|former|the first one|number one|1st)\b/.test(t)) return options[0];
  if (/\b(?:second|latter|the other one|the other|number two|2nd)\b/.test(t)) return options[1] ?? null;
  if (/\b(?:third|number three|3rd)\b/.test(t)) return options[2] ?? null;
  if (/\b(?:this|this one|that one|the one i'?m looking at)\b/.test(t)) {
    const pick = gazePick(attention, options.map((o) => o.id));
    if (pick.id != null) return options.find((o) => o.id === pick.id) ?? null;
  }
  return null;
}

/** "the Wool Coat or the Puffer Jacket?" */
export function whichQuestion(options) {
  const names = options.map((o) => `the ${String(o.title || "").slice(0, 60)}`);
  if (names.length <= 1) return `${names[0] ?? "Which one"}?`;
  const head = names.slice(0, -1).join(", ");
  return `${head[0].toUpperCase()}${head.slice(1)} or ${names.at(-1)}?`;
}
