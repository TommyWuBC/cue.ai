// "How much have I spent this month?" — a pie chart over the page, showing
// this month's spend plus what is currently in the cart, against the monthly
// budget. Hardcoded for the demo: $593.56 already spent against a $1,000
// budget, real server-side enforcement (server/checkout.py) uses
// CUE_MONTHLY_LIMIT_CENTS and is a separate, live number.

const SPENT = 593.56;
const LIMIT = 1000;

const money = (v) => `$${v.toFixed(2)}`;

function arc(cx, cy, r, startDeg, endDeg) {
  if (endDeg - startDeg >= 359.999) endDeg = startDeg + 359.999; // full circle needs two arcs
  const toXY = (deg) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x1, y1] = toXY(startDeg);
  const [x2, y2] = toXY(endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

/** Pure markup builder, testable without a browser. */
export function budgetHTML({ spent = SPENT, limit = LIMIT, cart = 0 } = {}) {
  const projected = spent + cart;
  const overBudget = projected > limit;
  const spentDeg = Math.min(360, (spent / limit) * 360);
  const cartDeg = Math.min(360 - spentDeg, (cart / limit) * 360);
  const cx = 70, cy = 70, r = 62;
  const slices = [
    cart > 0 ? `<path class="bg-slice bg-cart" d="${arc(cx, cy, r, spentDeg, spentDeg + cartDeg)}"/>` : "",
    `<path class="bg-slice bg-spent" d="${arc(cx, cy, r, 0, spentDeg)}"/>`,
  ].join("");
  return `
    <div class="bg-head">
      <h2>This month</h2>
      <button class="bg-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="bg-body">
      <svg class="bg-pie" viewBox="0 0 140 140" role="img" aria-label="${money(spent)} of ${money(limit)} spent this month">
        <circle class="bg-track" cx="${cx}" cy="${cy}" r="${r}"/>
        ${slices}
        <circle class="bg-hole" cx="${cx}" cy="${cy}" r="42"/>
        <text class="bg-center-amt" x="${cx}" y="${cy - 4}" text-anchor="middle">${money(projected)}</text>
        <text class="bg-center-of" x="${cx}" y="${cy + 16}" text-anchor="middle">of ${money(limit)}</text>
      </svg>
      <ul class="bg-legend">
        <li><span class="bg-dot bg-dot-spent"></span>Spent this month<b>${money(spent)}</b></li>
        ${cart > 0 ? `<li><span class="bg-dot bg-dot-cart"></span>This cart<b>${money(cart)}</b></li>` : ""}
        <li><span class="bg-dot bg-dot-room"></span>${overBudget ? "Over budget" : "Still have"}<b>${overBudget
          ? `-${money(projected - limit)}` : money(limit - projected)}</b></li>
      </ul>
    </div>
    <p class="bg-line">${overBudget
      ? `Adding this cart puts you at ${money(projected)} — that's over your ${money(limit)} budget.`
      : `You've spent ${money(spent)} this month. Adding this cart puts you at ${money(projected)} — still under your ${money(limit)} budget.`}</p>`;
}

export function createBudget({ root = () => document.getElementById("aura-root"), cartTotal = () => 0 } = {}) {
  let panel = null;

  function close() { panel?.remove(); panel = null; }

  function open() {
    const host = root();
    if (!host) return null;
    close();
    panel = document.createElement("div");
    panel.className = "cue-budget";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Monthly spending");
    const data = { spent: SPENT, limit: LIMIT, cart: Math.max(0, Number(cartTotal()) || 0) };
    panel.innerHTML = budgetHTML(data);
    host.append(panel);
    panel.addEventListener("click", (e) => { if (e.target.closest(".bg-close")) close(); });
    panel.querySelector(".bg-close")?.focus();
    return data;
  }

  return { open, close, isOpen: () => Boolean(panel) };
}
