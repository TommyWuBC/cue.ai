# Read this before debugging Cue on a live site

Written 2026-09-27, against `main` at `3071c54`. `CLAUDE.md` holds the rules and
`docs/DESIGN.md` the reasoning per area. This file is narrower: it is the set of
things that already cost a session hours, and that you cannot derive by reading
the code, because in every case the code looked right.

## The method that actually works

Every real bug below was found by measuring the live page and none by reasoning
about the source. Three habits, in order of how much time they saved:

**Verify the effect, not the resolution.** "Cue finds the right button" and "the
cart changed" are different claims. A whole afternoon went into confirming the
first while the second was false the entire time. If you cannot verify the
effect, say so out loud rather than reporting the part you could verify.

**Never reimplement the code you are testing.** The worst delay in this project
came from probing Amazon with a hand-written copy of `controlName()` that read
`input.value`, which the real one did not. Every probe passed, the product stayed
broken, and the reimplementation hid the real fault for hours. Copy the function
verbatim out of the file, or import it.

**Measure on the real site, twice.** Amazon renders the same listing differently
across items. A heuristic tuned on one product page will fail on the next one:
the detail region was 99% of the viewport on one listing and 45% on another, and
add-to-cart is `input[type=submit]` on one and `input[type=button]` on another.
Check any new rule against at least two different products before believing it.

## Traps that will bite again

**`node --check file.js` does not parse it the way the browser does.** With no
`"type": "module"` in `package.json`, it reads a `.js` file as a script, which is
sloppier than a module. `aura.js` shipped a stray `);` that was legal as a script
and a `SyntaxError` in the browser, so Cue's entire dispatch layer failed to load
on every page for several commits, while gaze and the avatar — separate module
graphs — kept running and made the app look alive. Force module parsing:

```bash
cp client/aura.js /tmp/check.mjs && node --check /tmp/check.mjs
```

A file no test imports is a file nothing has ever parsed.

**`querySelector` with a comma list returns the earliest element in DOM order,
not the first selector's match.** This has caused two separate bugs. The detail
adapter read an accessibility helper as the product title and a neighbouring
widget's $59.99 as a $52.99 price. Write ordered loops when the order of your
selectors is the point. `extract.js` has the comment; heed it.

**First match is rarely the right match on a marketplace.** An Amazon product
page carries six controls whose names contain "add", and the first in DOM order
is the warranty upsell, "Add protection". `addButtonIn` took it every time: right
flow, right readback, "Added." spoken, empty cart, and no error possible because
pressing it genuinely succeeded. The same shape of bug hit `findControl`, where
an on-screen partial match ("Add to cart, shift, option, K", Amazon's keyboard
hint baked into the accessible name) beat an exact match that was off the capped
list. Prefer exact, then specific, then first.

**`controls()` caps at 40 in DOM order and filters to the viewport.** Amazon has
~900 visible controls, so the buy box is not in that list. Anything that needs to
find a specific control must consult `clickables()` too.

**The product you are standing on is not a link.** `genericCards()` only
considers links, so on a detail page it returns the recommendation carousel and
omits the item itself. Detail pages are handled separately in `extract.js`, and
that region must enclose the buy control as well as the title, or an add is
scoped to an element that cannot reach its own button.

**Page type is not a count.** `pageBrief()` once required exactly one product to
call a page a product page. Carousels meant every Amazon item page was labelled
`results`, `page.product` was never set, and the model could not answer "what are
the reviews on this" because the prompt tells it `page.product` is the item.

## Where the Amazon flow actually stands

| Step | State |
|---|---|
| Search, filters | works |
| Product page: title, price, reviews | works |
| Add to cart | works — verified reaching Amazon checkout with the item |
| Cart, delivery options | `click_named` changes delivery windows on checkout |
| Place order | **executed end to end on 2026-09-27** — a real Amazon order was placed by voice |

The last row has now happened. Money controls stage, Cue reads the control back,
a separate spoken yes presses it, and that sequence placed a real order — items
the shopper partly did not want. Treat this path as live, not theoretical.

`stageCheckout()` used to answer "There's no cart on this page" on any real
site, because both of the globals it checks are the demo store's. It now falls
through to the shop's own money control and the same confirmation, so the
`checkout` verb and `click_named` reach the same place. The agent was also told,
in two different parts of one prompt, both that it may propose a money control
and that the page refuses them; the contradictory line is gone. If the model
starts telling shoppers to press the button themselves again, that instruction
has regressed.

## Things that are true and easy to get wrong

- **Gaze is currently off.** `GAZE_MODE = 'mouse'` in `extension/background.js`,
  and WebGazer is not injected at all. Nothing is numbered on screen either, so
  selection is by name. Anything that scopes by focus needs a fallback, which is
  why `add_to_cart` picks the product owning the page's add control.
- **The agent is Claude** (`claude-haiku-4-5-20251001`), not Grok. Grok is speech
  only. Needs `ANTHROPIC_API_KEY`.
- **The ElevenLabs ledger is cumulative for the life of the project** and never
  resets, while the account quota resets monthly. Hitting `ELEVEN_CHAR_BUDGET`
  does not mean you are out of credit; check
  `server/cache/_ledger.json` against the real account before believing it. A
  silent fall-through to the browser voice is what "the voice changed mid-demo"
  means.
- **Cue can hear itself.** A turn often speaks twice, and the mic returns the two
  lines blurred into one transcript that matches neither alone. `echoes()` in
  `client/speech.js` remembers the last few lines for exactly this reason. If you
  narrow it back to the line currently playing, Cue will talk itself in a circle
  again — it did, for a whole session.
- **`tests/test_convo.py` calls the real model**, so the suite is
  non-deterministic. `test_recommend_under_budget_names_one_and_why` fails in a
  full run and passes alone. Do not chase it as a regression.
- **`extension-browser.test.mjs` needs `puppeteer-core`**, which is not
  installed. Its failure is pre-existing.
- **Rebuild after touching `extension/` or `client/`**
  (`python3 tools/build-extension.py`), then reload the extension card in the
  browser. A rebuilt unpacked extension is not picked up until you do, and the
  old content script survives in already-open tabs until they are reloaded.

## Git traps in this repo

Local `main` tracks `origin/cue/accuracy-and-robustness`, not `origin/main`. A
bare `git push` goes to the wrong branch. Push explicitly:

```bash
git push origin HEAD:main
```

Feature branches here carry work that main lacks, and fixes made on a branch
often cannot be cherry-picked back: `client/speech.js` did not exist on main at
all, so "just my changes" would have landed a broken import. Check whether the
files you touched even exist on the target before promising to split work out.

## Decisions still open

- **The guardian flow is not built.** `docs/GUARDIAN_TODO.md` is the ordered list.
  Today the shopper approves with their own passkey; the pitch describes a
  trusted second person approving a signed request.
- **The pitch and the behaviour have diverged.** Devpost and expo copy say Cue
  "never touches a card and never spends on its own". Money controls now press
  after a spoken yes, so that sentence needs revisiting before it is read by a
  judge who tests it.
- **Two voices still narrate.** The model announces intent and the page
  announces outcomes; the page now stays quiet when the reply already said the
  same thing, but the underlying "who says what" split is worth settling rather
  than patching per verb.
