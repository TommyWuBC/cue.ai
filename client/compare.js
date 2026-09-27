// Two products side by side, over the page the shopper is already on.
//
// An in-page panel rather than a tab on purpose: Cue's microphone, voice loop
// and overlay all live in this document, and a foreground tab elsewhere puts
// this one in the background where Chrome throttles its timers to a second —
// which is the speech settle window. The comparison must not cost the voice.

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>';

const money = (v) => (typeof v === "number" && Number.isFinite(v)
  ? `$${v.toFixed(2).replace(/\.00$/, "")}` : "");

/** The panel's markup. Pure, so the shape is testable without a browser. */
export function compareHTML(data) {
  const d = data || {};
  const a = esc(d.titles?.a || "This one");
  const b = esc(d.titles?.b || "That one");
  const pick = d.pick === "b" ? "b" : "a";
  const winner = pick === "b" ? b : a;
  const head = (side, title) => `
    <div class="cc-card${pick === side ? " cc-win" : ""}">
      ${pick === side ? '<span class="cc-badge">Cue\u2019s pick</span>' : ""}
      <span class="cc-name">${title}</span>
      <span class="cc-price">${esc(money(d.prices?.[side]))}</span>
      ${d.voices?.[side] ? `<span class="cc-voice">${esc(d.voices[side])}</span>` : ""}
    </div>`;
  const rows = (d.rows || []).map((r) => `
    <tr>
      <th scope="row">${esc(r.label)}</th>
      <td${pick === "a" ? ' class="cc-col"' : ""}>${esc(r.a)}</td>
      <td${pick === "b" ? ' class="cc-col"' : ""}>${esc(r.b)}</td>
    </tr>`).join("");
  return `
    <div class="cc-head">
      <span class="cc-mark" aria-hidden="true">${MARK}</span>
      <h2>Side by side</h2>
      <button class="cc-close" type="button" aria-label="Close comparison">\u00d7</button>
    </div>
    ${d.verdict ? `<p class="cc-verdict">${esc(d.verdict)}</p>` : ""}
    <div class="cc-cards">${head("a", a)}${head("b", b)}</div>
    <table class="cc-table"><tbody>${rows}</tbody></table>
    <div class="cc-eco" hidden></div>
    <div class="cc-actions">
      <button class="cc-back" type="button">Go back</button>
      <button class="cc-add" type="button">Add the ${esc(winner)}</button>
    </div>`;
}

/**
 * `request(a, b)` resolves the comparison. `onAdd(pick)` adds that side and is
 * expected to close. `reveal` is how long the ecosystem line waits: it lands
 * after the shopper has taken in the table, not on top of it.
 */
export function createCompare({ request, onAdd, reveal = 1500, root = () => document.getElementById("aura-root") } = {}) {
  let panel = null;
  let token = 0;
  let timer = null;

  function close() {
    clearTimeout(timer);
    token++;
    panel?.remove();
    panel = null;
  }

  async function open(a, b) {
    const host = root();
    if (!host) return null;
    close();
    const mine = ++token;
    panel = document.createElement("div");
    panel.className = "cue-compare";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Product comparison");
    panel.innerHTML = `<div class="cc-loading" role="status"><span class="cc-spin" aria-hidden="true"></span>Reading both pages&hellip;</div>`;
    host.append(panel);
    panel.addEventListener("click", (e) => {
      if (e.target.closest(".cc-close,.cc-back")) close();
      else if (e.target.closest(".cc-add")) {
        const pick = panel?.dataset.pick === "b" ? "b" : "a";
        close();
        onAdd?.(pick);
      }
    });

    let data;
    try {
      data = await request(a, b);
    } catch (error) {
      if (mine !== token || !panel) return null;
      panel.innerHTML = `<div class="cc-loading">I couldn't read both of those well enough to compare them.</div>
        <div class="cc-actions"><button class="cc-back" type="button">Go back</button></div>`;
      console.warn("[cue] compare failed:", error);
      return null;
    }
    if (mine !== token || !panel) return null;
    panel.dataset.pick = data?.pick === "b" ? "b" : "a";
    // The shop's own prices, not the model's recollection of them.
    panel.innerHTML = compareHTML({ ...data, prices: { a: a?.price, b: b?.price } });
    panel.querySelector(".cc-close")?.focus();

    // The line about what they already own arrives a beat later, once the
    // table has been read. Delivered at once it reads as an upsell.
    if (data?.ecosystem) {
      timer = setTimeout(() => {
        if (mine !== token || !panel) return;
        const slot = panel.querySelector(".cc-eco");
        if (!slot) return;
        slot.textContent = data.ecosystem;
        slot.hidden = false;
        slot.classList.add("cc-eco-in");
      }, reveal);
    }
    return data;
  }

  return { open, close, isOpen: () => Boolean(panel) };
}
