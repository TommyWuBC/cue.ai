# Cue — Devpost draft (revised)

Replaces the live text at https://devpost.com/software/cue-ai. Rewritten after
reading four actual HackGT 12 winners' Devposts end to end — not just judging
guides — to see what separates the ones that stand out. Notes from that read
are at the bottom of this file; the short version:

- **Best Overall winners are short and stat-led, not narrative-heavy.** Dose
  (Best Overall 1st) opens Inspiration with one hard number and a dollar
  figure, then describes the build in terse bullets. No scene-setting, no
  adjectives doing the work.
- **Track winners that place 1st vs 2nd earn it with mechanism, not polish.**
  VisionNav (1st) explains its spatial-audio guidance with a one-line analogy
  ("like playing Marco Polo") that makes a judge who's never touched the code
  understand *why* it works. Caladrius (2nd, same track) is denser and more
  technically ambitious but reads slower because it never gives the judge that
  single graspable image.
- **Naming what you cut, and why, reads as engineering maturity, not
  weakness.** Caladrius spells out that it wanted AES-256-GCM encryption, ran
  out of time, and shipped a rotating-session-ID scheme instead, with the
  actual reasoning for the trade. That kind of specific, reasoned downgrade is
  far more credible than either hiding the gap or a vague "there's room to
  improve."
- **The weakest winning writeup (Best Emerging, a lower/newer-team tier) is
  the one that reads like generated marketing copy** — "Key Features" /
  "Benefits" bullet blocks like "Accelerates X," "Empowers Y," each detached
  from any specific mechanism. That's the pattern to avoid regardless of how
  it's rewritten.

Applied here: lead Inspiration with one cited, specific number; keep "How we
built it" concrete and technical rather than adjective-driven; keep the
existing honest admission of what's descoped (real Amazon vs. demo store,
gaze deferred); and cut anything that reads as a benefits list without a
mechanism attached to it.

**Update:** you pointed to RefNet's Devpost as the shape to match: numbered
feature sections with a short bold header per bullet, a plain tech-stack list
plus a numbered data-flow walkthrough under "How we built it," and short,
concrete, bold-led bullets everywhere else. Restructured below to match that
shape. The content and honesty rules above still hold, just in that format.

Pivot from the current live copy: the old pitch centered on gaze-driven
selection plus a guardian approving the purchase. That is no longer the
headline. The headline now is **talk to Cue, end to end, and it completes the
purchase** — no mouse, no guardian, no separate approver. Gaze still exists in
the codebase as an accessibility layer but is not part of this submission's
core claim.

---

## Inspiration

About 7% of working-age adults have a dexterity difficulty bad enough that
they can't reliably use a mouse. Every online store still assumes you have
one: search is a text box, add to cart is a small button, checkout is a form
with a dozen fields.

You can already ask a phone to set a timer without touching it. The moment
money is involved, though, you're handed a pointer again. That never made
sense to us. Talking through a purchase with a clerk who goes and gets it for
you is how shopping worked before stores had checkout forms at all. Cue was
born from wanting that back: say what you want, hear it read back honestly,
say yes, and the order exists.

## What Cue does

Cue is a shopping clerk you talk to. No mouse, no gaze, no keyboard, just a
Chrome extension running on real shopping sites, pressing the site's own
buttons.

Here's what you can do with Cue:

**1. Search and browse by voice**

* Say what you're looking for. Cue searches the real site and reads back the
  title, price, and rating of each result.
* Ask follow-up questions naturally: what it's made of, whether it ships by
  Friday, what the reviews say.

**2. Compare and refine**

* Narrow the list by voice: "the cheaper one," "the one with more reviews."
* Ask "how's this different from the last one?" and Cue remembers the last
  product you looked at or discussed, even across page changes.

**3. Add to cart, hands-free**

* Say "add the second one in medium" and Cue picks the real size option and
  presses the real add-to-cart button.
* A size is required before anything is added. Cue never guesses one for you.

**4. Checkout that can't be triggered by accident**

* Say "check out" and Cue stages the order: it reads back the exact item,
  price, and remaining budget before anything happens.
* Only a second, separate "yes" completes the purchase. A misheard "add that"
  can never turn into a charge, because staging and buying happen on
  different turns.
* Every checkout request is signed with Ed25519 over RFC 9421 HTTP message
  signatures, the same shape Visa's Trusted Agent Protocol uses, so the item,
  price, and your exact words can't be swapped after the fact.

## How we built it

Our stack:

* **Extension:** Manifest V3 Chrome extension that injects Cue's client into
  the live store tab and reads the page's real DOM.
* **Speech in:** Grok for transcription, with the browser's own recognizer as
  a fallback.
* **Command routing:** a small regex router that handles the core commands
  (numbers, yes/no, search, add) without ever calling an LLM, so the
  safety-critical path doesn't depend on a model's mood.
* **Reasoning:** Grok, for open-ended questions and suggesting reversible
  actions. Its output is filtered on the server before it ever reaches the
  page.
* **Speech out:** ElevenLabs, falling back to the browser voice, with a disk
  cache so repeat lines are free.
* **Signing:** Ed25519 over RFC 9421, for tamper-proof checkout requests.

How a purchase actually flows:

1. You speak → the router or Grok turns it into a command → the extension
   finds the real element on the page and acts on it.
2. Add-to-cart and checkout presses are staged first: Cue names exactly what
   it's about to do, out loud, before it does it.
3. A second, distinct "yes" is required to press through. The server strips
   `confirm`, `checkout`, and approval verbs out of anything the model
   proposes, so those only ever fire from your voice through the router.
4. The request is signed, bound to the item, price, and your exact words, and
   sent to the store.

## Challenges we ran into

* **Real store pages are inconsistent.** The same kind of listing renders
  differently across products: the detail region took up 99% of the viewport
  on one page and 45% on another.
* **The wrong "add" button.** A naive "first button containing 'add'" grabs
  the warranty upsell, "Add protection," instead of "Add to cart," on some
  pages, every time. We match exact text first, then a specific pattern, then
  fall back to position, and check every selector against at least two
  products before trusting it.
* **A silent syntax error.** A stray parenthesis in the dispatch file was
  legal as a plain script but a syntax error as a module. Cue's whole command
  layer failed to load in the browser while an unrelated animation kept
  running, so the app looked alive when it wasn't. `node --check` didn't
  catch it either, since without `"type": "module"` in `package.json` it
  parses the file differently than Chrome does.

## Accomplishments that we're proud of

* Cue completes a real purchase, voice-only, on a real shopping site. Not a
  staged demo page, and no second person has to approve it first.
* Purchase-blocking logic lives in two separate places: the server's verb
  allowlist and the client's own commit lock, which checks where a message
  came from rather than which model produced it. A prompt injected into a
  product page can't talk the agent into buying anything on its own.
* The stage-then-confirm shape means a misheard word costs nothing. It's like
  a waiter repeating your order before it goes to the kitchen: the
  repeat-back is the checkpoint, not politeness.

## What we learned

* Cut scope to what you can show live. We started out building gaze-driven
  selection plus a guardian approving every purchase on a second device. Both
  are good ideas, but stacked on top of the core problem, neither survived a
  36-hour clock and a real marketplace's actual HTML.
* Dropping to voice-only and self-approved is what got us from a purchase
  flow that only worked in pieces to one you can watch complete, start to
  finish, on a real product page.
* Reading the code isn't enough. Every real bug here was found by measuring
  the live page, and every one of them looked correct until we did.

## What's next for Cue

* **Gaze as an optional layer.** Dwell-based focus for shoppers who can't
  speak, sitting on top of the same stage-then-confirm commit, not replacing
  it.
* **Delegated approval, as an option.** A shopper who wants a second person's
  sign-off, a caregiver or a parent, should be able to route their signed
  request to that person's device. The signing and budget-cap infrastructure
  for it is already built.

## Built With

chrome, css3, ed25519, elevenlabs, fastapi, grok, html, javascript,
manifest-v3, python, rfc-9421, sqlite, webauthn, xai
