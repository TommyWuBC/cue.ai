// "wireless headphones under a hundred dollars, four stars, cheapest first" ->
// the words to search for, plus the filters a shop can apply itself.

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUM = "(?:\\$\\s?)?(?:\\d[\\d,]*(?:\\.\\d+)?|(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and|[\\s-])+)";
const MONEY = "(?:\\s*(?:dollars?|bucks?|usd))?";

/** "a hundred" / "two fifty" / "$1,200" / "49.99" -> number, or null. */
export function toNumber(text) {
  const t = String(text).toLowerCase().replace(/[$,]/g, "").trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  const words = t.split(/[\s-]+/).filter((w) => w && w !== "and");
  if (!words.length) return null;
  let total = 0, current = 0, seen = false, last = null;
  for (const w of words) {
    if (w === "a" || w === "an") { current = 1; seen = true; last = "a"; continue; }
    if (w in UNITS) {
      // "two fifty" reads as 250, "one fifty" as 150.
      current += UNITS[w]; seen = true; last = "u";
    } else if (w in TENS) {
      current += TENS[w]; seen = true;
      if (last === "u" && current >= 20 && current < 100 && words.length === 2 && words[0] in UNITS && UNITS[words[0]] < 10) {
        current = UNITS[words[0]] * 100 + TENS[w];
      }
      last = "t";
    } else if (w === "hundred") { current = (current || 1) * 100; seen = true; last = "h"; }
    else if (w === "thousand") { total += (current || 1) * 1000; current = 0; seen = true; last = "k"; }
    else return null;
  }
  return seen ? total + current : null;
}

export function parseSearch(raw) {
  let q = ` ${String(raw || "")} `;
  const out = { q: "", min: null, max: null, sort: null, prime: false, stars: null };
  const take = (re, fn) => {
    q = q.replace(re, (...m) => { fn(m); return " "; });
  };
  take(new RegExp(`\\b(?:between|from)\\s+(${NUM})${MONEY}\\s+(?:and|to)\\s+(${NUM})${MONEY}`, "i"), (m) => {
    const a = toNumber(m[1]), b = toNumber(m[2]);
    if (a != null && b != null) { out.min = Math.min(a, b); out.max = Math.max(a, b); }
  });
  take(new RegExp(`\\b(?:under|below|less than|cheaper than|up to|no more than|at most|max(?:imum)?(?: of)?)\\s+(${NUM})${MONEY}`, "i"), (m) => {
    const n = toNumber(m[1]); if (n != null) out.max = n;
  });
  take(new RegExp(`\\b(?:over|above|more than|at least|min(?:imum)?(?: of)?)\\s+(${NUM})${MONEY}`, "i"), (m) => {
    const n = toNumber(m[1]); if (n != null) out.min = n;
  });
  take(/\b(?:(\d(?:\.\d)?|four|three)\s*(?:\+\s*)?stars?(?:\s+(?:and up|or (?:more|higher|better)|\+))?|highly rated|top rated|well rated)\b/i, (m) => {
    const w = String(m[1] || "4").toLowerCase();
    out.stars = w === "three" ? 3 : w === "four" ? 4 : Number(w) || 4;
  });
  take(/\b(?:cheapest first|lowest price(?: first)?|price low to high|cheapest|lowest priced)\b/i, () => { out.sort = "price-asc"; });
  take(/\b(?:most expensive first|price high to low|highest price(?: first)?)\b/i, () => { out.sort = "price-desc"; });
  take(/\b(?:best rated|highest rated|best reviewed|top reviewed|by rating)\b/i, () => { out.sort = "rating"; });
  take(/\b(?:newest|latest|new arrivals)\b/i, () => { out.sort = "newest"; });
  take(/\bprime(?: eligible| shipping| only)?\b/i, () => { out.prime = true; });
  out.q = q.replace(/\b(?:please|for me|can you|search for|find me|look for|show me)\b/gi, " ")
    .replace(/[,;]+/g, " ").replace(/\s+/g, " ").trim();
  return out;
}

const AMAZON_SORT = { "price-asc": "price-asc-rank", "price-desc": "price-desc-rank",
  rating: "review-rank", newest: "date-desc-rank" };

/** A results URL that applies the filters, for Amazon only. Null elsewhere. */
export function amazonSearchUrl(parsed, pageUrl) {
  let base;
  try { base = new URL(pageUrl); } catch { return null; }
  if (!/(^|\.)amazon\.[a-z.]+$/i.test(base.hostname) || !parsed.q) return null;
  const u = new URL("/s", base.origin);
  u.searchParams.set("k", parsed.q);
  if (parsed.min != null) u.searchParams.set("low-price", String(parsed.min));
  if (parsed.max != null) u.searchParams.set("high-price", String(parsed.max));
  if (parsed.sort && AMAZON_SORT[parsed.sort]) u.searchParams.set("s", AMAZON_SORT[parsed.sort]);
  const rh = [];
  if (parsed.prime && base.hostname.endsWith("amazon.com")) rh.push("p_85:2470955011");
  if (parsed.stars && base.hostname.endsWith("amazon.com")) rh.push(parsed.stars >= 4 ? "p_72:1248879011" : "p_72:1248880011");
  if (rh.length) u.searchParams.set("rh", rh.join(","));
  return u.href;
}

/** What Cue says it applied, in plain words. */
export function describeFilters(p) {
  const bits = [];
  if (p.min != null && p.max != null) bits.push(`between ${p.min} and ${p.max} dollars`);
  else if (p.max != null) bits.push(`under ${p.max} dollars`);
  else if (p.min != null) bits.push(`over ${p.min} dollars`);
  if (p.stars) bits.push(`${p.stars} stars and up`);
  if (p.prime) bits.push("Prime");
  if (p.sort === "price-asc") bits.push("cheapest first");
  if (p.sort === "price-desc") bits.push("priciest first");
  if (p.sort === "rating") bits.push("best rated first");
  if (p.sort === "newest") bits.push("newest first");
  return bits.join(", ");
}
