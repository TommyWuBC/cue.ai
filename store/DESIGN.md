# Northfield + Cue: design notes

Two voices on one page. **Northfield** is the store: quiet, photographic, a
real shop that has nothing to do with AI. **Cue** is the guest: a small robot
that lives in one corner and speaks up only when spoken to. The store never
borrows Cue's color; Cue never borrows the store's type.

## Tokens (`store/base.css`)

| Token        | Hex       | Use                                              |
|--------------|-----------|--------------------------------------------------|
| `--paper`    | `#FFFFFF` | page                                             |
| `--mist`     | `#F2F2F4` | photo wells, quiet surfaces                      |
| `--hair`     | `#E4E4E7` | 1px dividers, control borders                    |
| `--graphite` | `#6E6E73` | secondary text                                   |
| `--ink`      | `#1D1D1F` | text, primary buttons                            |
| `--cue`      | `#2F6BFF` | Cue only: focus outline, listening state, avatar |
| `--trust`    | `#1A1F71` | payment approval, merchant verification          |

Type: **Newsreader** (display serif, optical sizes) for headlines, product
names at large sizes and money totals in review screens. **Geist** for
everything you click or scan. Sentence case everywhere, no all-caps labels.

## Rules

- Photos carry the page. Cards are not boxed: image, then text, on white.
- Hit targets for gaze are big on purpose: sizes are 44px, add-to-bag is 48px.
- Radius follows size: 999px for pills, 14px for sheets, 4px for photos.
- Motion answers an action (added to bag, order arrived, focus moved) or
  belongs to Cue. The store itself does not animate on load.
- Cue's avatar reacts to real events on `window.cue.bus`: it looks where you
  look, listens while you hold space, thinks while a request is in flight,
  talks while TTS plays, and is happy or concerned depending on the reply.
