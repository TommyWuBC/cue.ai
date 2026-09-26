// Help centre: topics, FAQ, size tables (also used by the size-guide dialog).
import { crumbs } from "../ui.js";
import { esc } from "../util.js";

const view = () => document.getElementById("view");

const TOPICS = {
  shipping: { title: "Shipping", lede: "Where we ship, how long it takes, and what it costs." },
  returns: { title: "Returns and exchanges", lede: "Thirty days, free, for anything unworn." },
  "size-guide": { title: "Size guide", lede: "Body measurements for our letter sizes, and how to take your own." },
  repairs: { title: "Repairs", lede: "Free repairs for the life of anything we make." },
  contact: { title: "Contact us", lede: "A person reads every message. We reply within one working day." },
  "shopping-with-cue": { title: "Shopping with Cue", lede: "How to browse, ask and buy with your eyes and your voice." },
};

const FAQ = [
  ["When will my order arrive?", "Standard delivery in the US takes 3 to 5 working days. Express takes 1 to 2. You get a tracking link by email as soon as the parcel leaves our warehouse."],
  ["Can I change or cancel an order?", "Within one hour of placing it, yes. Contact us with your order number. After that the order is usually packed, and a free return is the quickest route."],
  ["How do returns work?", "Start a return from your account or the link in your delivery email. Drop the parcel at any carrier point. Refunds go back to the original payment within 5 working days of arrival."],
  ["Do you repair things you didn't make?", "Our repair studios only take Northfield pieces, so we can match the original thread, buttons and cloth."],
  ["Which size should I choose?", "Each product page says whether it runs large, small or true to size. If you are between sizes on something marked true to size, take the larger one for coats and the smaller one for knitwear."],
  ["How does Cue know what I'm looking at?", "Your webcam estimates roughly where you are looking, and Cue numbers the products in that area. It never acts on your gaze alone. You pick by saying the number, and nothing is bought until you approve it."],
];

export function sizeTables() {
  const row = (s, ...cols) => `<tr><th scope="row">${s}</th>${cols.map(c => `<td>${c}</td>`).join("")}</tr>`;
  const cm = inches => Math.round(inches * 2.54);
  const table = (caption, rows) => `
    <table class="help-table">
      <caption>${caption}</caption>
      <thead><tr><th scope="col">Size</th><th scope="col">Chest</th><th scope="col">Waist</th><th scope="col">Hip</th></tr></thead>
      <tbody>${rows.map(([s, c, w, h]) => row(s, `${c}″ <span>${cm(c)} cm</span>`, `${w}″ <span>${cm(w)} cm</span>`, `${h}″ <span>${cm(h)} cm</span>`)).join("")}</tbody>
    </table>`;
  return `
    <div class="help-tables">
      ${table("Women", [["XS", 32, 25, 35], ["S", 34, 27, 37], ["M", 36, 29, 39], ["L", 39, 32, 42], ["XL", 42, 35, 45]])}
      ${table("Men", [["XS", 34, 28, 34], ["S", 37, 30, 36], ["M", 40, 33, 39], ["L", 43, 36, 42], ["XL", 46, 39, 45]])}
    </div>
    <div class="help-measure">
      <h3>How to measure</h3>
      <dl>
        <dt>Chest</dt><dd>Around the fullest part, under the arms, with the tape level across your back.</dd>
        <dt>Waist</dt><dd>Around your natural waist, the narrowest point, with one finger under the tape.</dd>
        <dt>Hip</dt><dd>Around the fullest part of your hips, feet together.</dd>
      </dl>
      <p>Measure over a thin layer. If you are between sizes, the product page tells you which way that piece runs.</p>
    </div>`;
}

const BODY = {
  shipping: () => `
    <table class="help-table help-table-plain">
      <thead><tr><th scope="col">Service</th><th scope="col">Time</th><th scope="col">Cost</th></tr></thead>
      <tbody>
        <tr><th scope="row">Standard</th><td>3 to 5 working days</td><td>Free over $150, otherwise $8</td></tr>
        <tr><th scope="row">Express</th><td>1 to 2 working days</td><td>$18</td></tr>
        <tr><th scope="row">Canada</th><td>5 to 8 working days</td><td>Free over $200, otherwise $15</td></tr>
        <tr><th scope="row">Store pickup</th><td>Next working day</td><td>Free</td></tr>
      </tbody>
    </table>
    <h2>Packaging</h2>
    <p>Everything ships in recycled cardboard with paper tape. Knitwear is folded in tissue, coats are sent on a card hanger inside the box so they arrive without creases.</p>
    <h2>Duties</h2>
    <p>Orders to Canada are sent with duties paid. The price you see at checkout is the price you pay.</p>`,
  returns: () => `
    <ol class="help-steps">
      <li><b>Start a return</b><span>From your account, or the link in your delivery email. Choose the items and a reason.</span></li>
      <li><b>Pack it up</b><span>Use the original box if you still have it. Print the label or show the QR code at the drop-off point.</span></li>
      <li><b>Get your refund</b><span>Within 5 working days of the parcel reaching us, to the original payment method.</span></li>
    </ol>
    <h2>What we accept</h2>
    <p>Anything unworn, unwashed and with its tags, within 30 days of delivery. Exchanges for a different size are free and ship as soon as the return is scanned.</p>
    <h2>Exceptions</h2>
    <p>Earrings and items altered by our tailors cannot be returned. Faulty items can always be returned or repaired, whatever their age.</p>`,
  "size-guide": () => sizeTables(),
  repairs: () => `
    <p class="help-intro">Buttons, seams, zips, linings, elbow patches, re-waxing. If we made it, we will repair it for free for as long as you own it. You pay nothing, including postage.</p>
    <ol class="help-steps">
      <li><b>Tell us what needs fixing</b><span>Send a photo through the contact form, or bring it to any of our stores.</span></li>
      <li><b>Send it free</b><span>We email a prepaid label. Most repairs take two to three weeks.</span></li>
      <li><b>Wear it again</b><span>It comes back cleaned, with a note of what we did.</span></li>
    </ol>
    <h2>What we can't repair</h2>
    <p>Damage from bleach or a hot wash that has felted the fibres. We will still look at it, and if we cannot fix it we will tell you why.</p>
    <p><a class="help-link" href="/stores">Find a store with a repair studio</a></p>`,
  contact: () => `
    <div class="help-contact">
      <form class="help-form" id="help-form">
        <label>Name<input name="name" required autocomplete="name"></label>
        <label>Email<input name="email" type="email" required autocomplete="email"></label>
        <label>Order number <span>(optional)</span><input name="order"></label>
        <label>Topic
          <select name="topic"><option>An order</option><option>A return</option><option>A repair</option><option>Sizing advice</option><option>Something else</option></select>
        </label>
        <label class="help-wide">Message<textarea name="message" rows="5" required></textarea></label>
        <button class="btn btn-primary" type="submit">Send message</button>
      </form>
      <div class="help-sent" id="help-sent" hidden>
        <h2>Message sent</h2>
        <p>Thanks. We have your message and will reply to <b id="help-sent-email"></b> within one working day.</p>
      </div>
      <aside class="help-aside">
        <h2>Other ways to reach us</h2>
        <p><b>Phone</b><br>+1 (404) 555 0148<br>Monday to Friday, 9am to 6pm ET</p>
        <p><b>Email</b><br>help@northfield.example</p>
        <p><b>In person</b><br><a href="/stores">Our stores</a></p>
      </aside>
    </div>`,
  "shopping-with-cue": () => `
    <p class="help-intro">Cue lets you shop this site without a mouse or a keyboard. It is built for anyone who finds a trackpad hard to use, and it works with the webcam you already have. Your camera video never leaves your device.</p>
    <ol class="help-steps">
      <li><b>Calibrate</b><span>Look at each dot as it appears and say “Cue, next”. It takes about thirty seconds. If tracking drifts later, say “Cue, recalibrate”.</span></li>
      <li><b>Look, then say the number</b><span>Cue puts numbers on the products near where you are looking. Say “two” to pick the second one. Looking alone never selects or buys anything.</span></li>
      <li><b>Ask about it</b><span>“Cue, is this wool?” “Does it run small?” “How is this different from the last one?” Answers come from the product details on the page.</span></li>
      <li><b>Choose and add</b><span>“Medium, in black. Add it.” If you have not chosen a size, Cue asks rather than guessing.</span></li>
      <li><b>Check out</b><span>Say “Cue, check out”. Cue reads back every item, the total and what remains of your monthly budget before anything happens.</span></li>
      <li><b>Approve</b><span>Say “yes”, then approve with your passkey, using Face ID or a fingerprint on your phone or computer. Say “cancel” at any point to stop.</span></li>
    </ol>
    <h2>Spending limits</h2>
    <p>Every order is checked against a per-order limit and a monthly budget, and the store's server rechecks both before the order is recorded. You can see your limits and what remains in <a class="help-link" href="/account/limits">your account</a>.</p>
    <h2>Other commands</h2>
    <ul class="help-commands">
      <li>“Cue, scroll down” / “scroll to top”</li>
      <li>“Cue, go back”</li>
      <li>“Cue, click this” while looking at a button</li>
      <li>Hold the space bar to talk without saying “Cue”</li>
    </ul>`,
};

function shell(title, lede, body, trail) {
  return `
    <div class="pg help">
      ${crumbs(trail)}
      <div class="help-layout">
        <nav class="help-nav" aria-label="Help topics">
          <a href="/help" ${location.pathname.replace(/\/$/, "") === "/help" ? 'aria-current="page"' : ""}>Help centre</a>
          ${Object.entries(TOPICS).map(([k, t]) => `<a href="/help/${k}" ${location.pathname === `/help/${k}` ? 'aria-current="page"' : ""}>${esc(t.title)}</a>`).join("")}
        </nav>
        <div class="help-main">
          <h1 class="pg-title">${esc(title)}</h1>
          <p class="pg-lede">${esc(lede)}</p>
          <div class="help-body">${body}</div>
        </div>
      </div>
    </div>`;
}

export function index() {
  const cards = Object.entries(TOPICS).map(([k, t]) =>
    `<a class="help-card" href="/help/${k}"><h2>${esc(t.title)}</h2><p>${esc(t.lede)}</p></a>`).join("");
  const faq = FAQ.map(([q, a]) => `<details class="help-faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("");
  view().innerHTML = shell("Help centre", "Answers to the questions we hear most, and how to reach a person when you need one.",
    `<div class="help-cards">${cards}</div><h2>Frequently asked</h2><div class="help-faqs">${faq}</div>`,
    [["Home", "/"], ["Help"]]);
  return { title: "Help", name: "help" };
}

export function topic({ params }) {
  const t = TOPICS[params.topic];
  if (!t) return import("./notfound.js").then(m => m.default());
  view().innerHTML = shell(t.title, t.lede, BODY[params.topic](), [["Home", "/"], ["Help", "/help"], [t.title]]);
  const form = document.getElementById("help-form");
  form?.addEventListener("submit", e => {
    e.preventDefault();
    document.getElementById("help-sent-email").textContent = form.email.value;
    form.hidden = true;
    document.getElementById("help-sent").hidden = false;
  });
  return { title: t.title, name: "help" };
}
