# Design system — tokens & themes

> The colour vocabulary, the eight themes, the accent derivation, and the two guards that
> keep all of it readable. Current reference.

---

## 1. The one hard rule

**Every colour in Keyhold is a token. There are no hardcoded colours anywhere.**

Not a style preference — decision D8, with two automated guards behind it:

1. Every token resolves in every theme.
2. Every declared foreground/background pair meets WCAG AA in every theme.

A missing token renders as an invisible element — text the colour of its background, or a
panel with no fill — and nobody notices until a user reports a blank screen in one theme.
Contrast is impossible to eyeball, and the failure is not "looks washed out" but "a user
with low vision cannot read their own password".

---

## 2. Why themes live in TypeScript

The obvious approach is one `.css` file per theme. It was rejected because it creates a
**second list**: the contrast guard would have to parse CSS, or keep its own copy of each
palette, and the two would disagree within a month.

Defining themes as data (`src/shared/theme/themes.ts`) means one source feeds three
consumers:

```
                    ┌─► the CSS custom properties applied at runtime
  themes.ts ────────┼─► the contrast guard (themes.test.ts)
  (typed data)      └─► the theme editor's UI and preview
```

Adding a token to `COLOUR_TOKENS` makes every theme that lacks it a **type error**, which
is exactly the right failure mode.

---

## 3. The token vocabulary

`src/shared/theme/tokens.ts`. Each becomes `--kh-color-<token>`.

| Group    | Tokens                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------- |
| Surfaces | `bg` · `surface` · `surface-raised` · `surface-sunken` · `surface-hover` · `overlay`               |
| Lines    | `border` · `border-strong` · `focus-ring`                                                          |
| Text     | `text` · `text-muted` · `text-subtle` · `text-inverse`                                             |
| Accent   | `accent` · `accent-hover` · `accent-active` · `accent-on` · `accent-subtle` · `accent-subtle-text` |
| Status   | `success` / `warning` / `danger` / `info`, each with a `-text` and `-subtle` variant               |

Two distinctions worth understanding:

**`accent-on` is not `text-inverse`.** The accent is user-selectable, so the label colour
on top of it has to be derived alongside it. Using `text-inverse` on a primary button is a
bug waiting for someone to pick a bright accent.

**`text-subtle` is held to 3:1, not 4.5:1** — and is therefore only for non-essential
ornament: a separator label, a keyboard hint. Anything a user must read uses `text` or
`text-muted`.

**Status colours carry meaning, not decoration.** They are the health dashboard's signal.
This is why the global guidance about keeping decorative labels calm matters here: if tags
were also red and green, real warnings would stop reading as warnings.

---

## 4. The eight themes

| Theme           | Scheme | Character                                                                   |
| --------------- | ------ | --------------------------------------------------------------------------- |
| **Dawn**        | light  | Clean and neutral. The default when the OS is light                         |
| **Midnight**    | dark   | Deep blue-grey. The default when the OS is dark                             |
| Slate           | dark   | Cooler and softer, for long sessions                                        |
| Nord            | dark   | The arctic palette                                                          |
| Solarized Light | light  | Ethan Schoonover's low-contrast light palette                               |
| Solarized Dark  | dark   | Its dark counterpart                                                        |
| Rose            | light  | Warm, deep pink accent                                                      |
| High Contrast   | dark   | Pure black and white for low vision and bright sunlight. Deliberately harsh |

**Several values are darker or lighter than they would look best at, because the guard
rejected the prettier version.** Two examples, both found by the test and both marginal
enough that no amount of looking would have caught them:

- Dawn's `border-strong` was `#8b8fa3` — **2.99:1** against the background, a hair under
  the 3.0 floor for a UI boundary (WCAG 2.2 SC 1.4.11).
- Nord's `danger-text` used the palette's own `#d98a91` — **4.23:1** on its surface. Error
  text is precisely the text a user must be able to read, so it was lightened without
  exception.

---

## 5. The accent, and the runtime contrast problem

The accent picker lets a user choose **any** colour. That is the feature, and it is the
problem: the theme guard runs at build time on the eight built-in palettes, and cannot see
whatever someone picks at runtime.

A naive implementation ("accent = what they picked, `accent-on` = white") gives
**white-on-yellow at about 1.6:1** the moment anyone chooses a bright colour.

So `src/shared/theme/accent.ts` derives the whole ramp by **measuring**:

```
towardReadable = dark theme ? white : black
label          = the opposite extreme

1. accent  = push(chosen, towardReadable) until ≥ 3:1 vs the background   (usable as a border)
2. accent  = push(accent,  towardReadable) until ≥ 4.5:1 vs the label     (readable text)
3. hover   = mix(accent, towardReadable, 0.13)
   active  = mix(accent, towardReadable, 0.24)
```

### Why the direction is fixed by the scheme

Every step moves the same way, which is what makes the derivation **always satisfiable**.

Letting the label be chosen independently — whichever of black or white happens to suit the
user's colour — creates a genuine conflict in half the cases: the accent then has to move
_toward_ the background to satisfy the label, and _toward_ the label to stay visible as a
border. No value satisfies both. The first implementation of this file did exactly that,
and the guard produced 40 failures across the theme × preset matrix.

The fixed direction also matches what design systems converge on anyway: dark interfaces
use bright accents with dark labels, light interfaces use deep accents with white labels.

### Why hover and active move away from the label

Monotonicity. Moving toward a fixed "emphasis" colour makes the label contrast **worse** in
one of the two schemes — so a button readable at rest becomes unreadable on hover. Moving
consistently away from the label means every state is at least as readable as the rest
state, and a pressed button reads as more emphatic rather than faded.

### Quantise before measuring

A subtle bug the guard caught: candidates were measured as unrounded blends and only
rounded to 8-bit channels afterwards. A candidate accepted at exactly 4.50:1 emitted a hex
colour at **4.48:1** — under the bar, with a passing test. Every candidate is now quantised
before its contrast is measured.

`accent.test.ts` verifies **every theme × every preset × every requirement**, plus ten
deliberately hostile colours (pure yellow, pure white, pure black, mid-grey, navy).

---

## 6. Density, type, motion

| Setting       | Values                               | Notes                                                                                                                                                            |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Density       | compact / **comfortable** / spacious | `comfortable` and `spacious` keep rows at or above the 44px WCAG target size. `compact` deliberately goes below, which is why it is opt-in and never the default |
| Text size     | 87.5% – 150%                         | Multiplies the whole type scale, not one element                                                                                                                 |
| Font          | system / sans / serif / mono         | Body text only                                                                                                                                                   |
| Reduce motion | on / off                             | **OR-ed with the OS preference, never overriding it**                                                                                                            |

**Secrets always use a monospace face**, whatever the body font is set to. A password in a
proportional face makes `l`, `1`, `I` and `|` — and `0` versus `O` — genuinely ambiguous,
and people do still retype passwords by eye into terminals and other devices.

**Reduced motion collapses `--kh-motion-scale` to `0`**, and every duration in the system
is `calc(<n>ms * var(--kh-motion-scale))`. One switch stops every transition and animation
in the app, rather than each component having to remember to check a media query.

---

## 7. Applying it

`src/renderer/src/theme/appearance-store.ts` writes the resolved palette to
`documentElement` as CSS custom properties, and is deliberately **outside React's render
path**: switching theme re-paints without re-rendering a single component. Threading
colours through props or context would re-render everything on a theme change and make it
far too easy to hardcode a colour "just here".

Two details that matter more than they look:

**`color-scheme` is set alongside the properties.** Without it, a dark app renders a white
native dropdown and a white caret — the single most common way a themed Electron app gives
itself away.

**Appearance is applied before React mounts**, from the entry point rather than an effect.
An effect runs after the first paint, which means one frame of default colours — a white
flash on a dark theme, on every launch.

Appearance is stored in `localStorage`: it is a per-machine preference, contains nothing
secret, and must be readable before first paint. Every access is wrapped, because storage
throws outright in some contexts and a theme preference is never worth failing to start
over.

---

## 8. `.keeptheme`

Plain JSON — no secrets, so no encryption.

```json
{ "format": "keyhold-theme", "version": 1, "name": "My Theme", "scheme": "dark", "palette": { … } }
```

Import validates and **names the missing tokens** rather than saying "incomplete", because
a theme author otherwise has to hunt through thirty values to find which two they missed.

---

## 9. Tests

| File                                  | Covers                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/shared/theme/themes.test.ts`     | Token completeness, parseability, no unknown keys, and **every contrast requirement × every theme** (252 assertions) |
| `src/shared/theme/accent.test.ts`     | Every theme × every preset × every requirement, plus ten hostile colours (~970 assertions)                           |
| `src/shared/theme/appearance.test.ts` | Resolution, fallbacks, reduced-motion precedence, CSS variables, settings coercion, `.keeptheme` round-trip          |

---

## 10. Related

- [`01-Layout-And-Components.md`](./01-Layout-And-Components.md) — the shell and the component rules
- [`../00-Overview/00-What-Is-Keyhold.md`](../00-Overview/00-What-Is-Keyhold.md) — goal G4, why polish is a goal at all
- [`../12-Roadmap/02-Decision-Log.md`](../12-Roadmap/02-Decision-Log.md) — D8 (theming) and D7 (layout)
