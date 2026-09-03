# 06.05 · UI styles, and the token split

> The second appearance axis. A **theme** decides colour; a **style** decides what a surface
> is made of. Four styles × eight themes, and all thirty-two combinations are contrast-checked
> before they ship.

> **Status:** built and reachable. `shared/theme/style-tokens.ts` and `styles.ts` are the
> layer, `appearance.ts` emits it, and the picker is at the top of the Appearance panel —
> above the theme grid, because a style is the coarser choice.

---

## 1. The rule that draws the line

One sentence, applied literally:

> A token belongs to the **style** if changing the colour theme should not change it, and to
> the **theme** if changing the style should not.

That is the whole of it, and it settles nearly every case on its own. A border width is the
same 1px under Nord and under Dawn, so it is the style's. A border _colour_ differs between
them and not between Flat and Minimalist, so it is the theme's.

| Layer     | Prefix         | Owns                                                                                                                                                                  |
| --------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Theme** | `--kh-color-*` | Every hue. `COLOUR_TOKENS`, one entry per palette key, unchanged by this work                                                                                         |
| **Style** | `--kh-style-*` | Border and divider widths, border opacity, a radius multiplier, four shadows, surface and fill opacity, blur, the texture image/size/opacity, and the accent gradient |

Both are emitted in one pass by `toCssVariables`, because they land on the same element and a
stylesheet reading a half-applied appearance would flash.

---

## 2. The three cases worth explaining

### Shadows belong to the style, whole

Their **geometry** is the single strongest style signal. Neumorphism is _defined_ by casting
two shadows — a dark one away from the light and a lighter one toward it — and no
strength-multiplier over a single shadow can produce the second. So a style owns the entire
`box-shadow` value rather than a scale factor.

Their **colour** must still follow the theme, so every one resolves through
`color-mix(in srgb, var(--kh-color-overlay) N%, transparent)`. `overlay` is the palette's own
scrim colour and every theme already tunes it.

This replaced the one colour in the app that never followed the theme: `--kh-shadow-sm/md/lg`
held `rgb(0 0 0 / …)`, and a black shadow under a dark palette is a smudge rather than a lift.

### Radius is a multiplier, not four more tokens

`--kh-style-radius-scale` is unitless and multiplies the existing `sm`/`md`/`lg` ladder. Four
independent radius tokens would let the ladder lose its proportions — a card ending up rounder
than the chip inside it — which is the kind of wrongness nobody can name but everybody sees.

`--kh-radius-full` is exempt. A pill is a pill under every style.

### `border-opacity` applies to `--kh-color-border` and to nothing else

Enforced by `FADEABLE_LINE_TOKENS` and two tests. The reason is a measurement rather than a
preference: `border-strong` on `bg` in Dawn was deliberately darkened until it cleared 3.0 **by
a hair**, so fading it by _any_ amount puts a theme under AA. The same holds for `focus-ring`.

In CSS this is the difference between `--kh-edge` — the decorative edge, on panels, cards and
buttons — and a control outline, which keeps `--kh-color-border-strong` at a fixed 1px. An
input's outline carries WCAG 1.4.11 weight; a card's does not.

---

## 3. What the style layer deliberately does not own

Each of these was considered and refused, and the reasons are the useful part:

- **The focus ring.** A style that could thin or fade `:focus-visible` is a style that breaks
  the app for keyboard users while looking better to everyone else. It stays in `base.css` and
  the palette.
- **Motion and easing.** `--kh-motion-scale` is already the one dial on an accessibility axis.
  A second one is how those axes get out of sync.
- **Spacing, type scale, density, row heights.** That is the _layout_ axis, owned by `base.css`
  and the density setting. A style changes what a surface is made of, not how much screen it
  takes.

---

## 4. The four styles

| Id            | Name                  | What it is                                                                                |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `flat`        | Flat                  | The look Keyhold shipped with, kept and named so choosing a style is never a one-way door |
| `minimalist`  | Minimalist            | Less chrome, hairline borders, almost no elevation                                        |
| `neumorphic`  | Neumorphic            | No borders at all; surfaces defined entirely by dual-light shadows                        |
| `holographic` | Holographic Blueprint | **The default.** A background grid, translucent surfaces, blur, gradient fills            |

`FALLBACK_STYLE` is **Flat, not the default**: "we do not know what you asked for" should not
be answered with translucency and a backdrop filter.

### Two of Holographic's numbers are contrast constraints, not taste

Both were measured against every theme rather than chosen:

- **`fill-opacity` has a floor of 91%.** Binding case: Solarized Light, `accent-on` (white) on
  `accent`. Shipped at **96%**, five points of margin for the user's own accent colour, which
  runs through `applyAccent` and is only guaranteed against an _opaque_ fill.
- **`texture-opacity` has a ceiling of 29%.** Binding pair: `border-strong` on `bg` in Rose
  (2.98:1) and Solarized Light (2.88:1) — an input outline held to 3:1. Shipped at **22%**. A
  grid strong enough to read clearly is a grid that hides the edge of a text field.

### Neumorphism is weak on Dawn and Rose

Both set `surface-raised` and `surface` to pure white, so the dual-light highlight has nothing
to be lighter than. That is a real property of extruded surfaces on a white page rather than
something to code around — recorded here so it does not get "fixed" later.

---

## 5. Reduced transparency

Expressible entirely through the token set: `surface-opacity` → `100%`, `fill-opacity` →
`100%`, `blur` → `0px`, `texture-opacity` → `0%`. A style forced to those values is by
definition contrast-safe, because 100% opaque is exactly the un-composited case the theme
contrast guard already verifies.

**It is applied in JavaScript, not in a media query, and that is not a preference.**
`applyToDocument` writes these as inline properties on the root element, and an inline
property beats any `:root` rule — so a `@media (prefers-reduced-transparency: reduce)` block
would be dead the moment JavaScript ran. `base.css` carries one anyway, for the frame before
that happens, exactly as it already does for reduced motion. `toCssVariables` applies the
override **after** the style's own tokens, so a style cannot opt out of an access need by
declaring different numbers.

The OS preference is OR'd with the user's setting, never overridden — the same rule
`reduceMotion` follows.

---

## 6. The guards

| Guard                                                         | Where                                                     | Catches                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Every style declares every style token                        | the type, plus `styles.test.ts`                           | A missing token — a compile error, and an empty one if it compiles    |
| Every foreground/background pair passes AA, per style × theme | `styles.test.ts`                                          | A style whose translucency pushes a real pair under the floor         |
| No style token contains a colour literal                      | `styles.test.ts` and `tools/no-hardcoded-colours.test.ts` | Hard rule 4, which does not relax for a style                         |
| A style token references only real tokens                     | `styles.test.ts`                                          | A typo'd `var()`, which resolves to nothing and drops the declaration |
| Ids are unique and URL-safe                                   | `styles.test.ts`                                          | Two styles that cannot be told apart in a data attribute              |
| Every `var(--kh-style-…)` a stylesheet reads is declared      | `tools/css-tokens-resolve.test.ts`                        | The same silent-drop failure, from the consuming side                 |

The compositing maths those contrast checks rely on is itself tested, because a no-op
compositor would leave every translucency check passing while proving nothing.

**Gradients are the one thing the contrast guard cannot model** — a `linear-gradient` has no
single background colour. Rather than pretend otherwise, a test requires every colour
`accent-image` reaches for to be one `CONTRAST_REQUIREMENTS` already declares as a background,
so the gradient can only land on a pair something already checks. Adding a stop in a colour
outside that set fails the guard, and it is telling the truth.

---

## 7. What a test cannot see

The grid was invisible on first run, and every guard passed. Three full-bleed surfaces
repainted `--kh-color-bg` — the colour `body` already carried — over the texture layer behind
them, so the widest region of the window was the one place a blueprint grid could not show
through. Nothing about that is a contrast failure or a missing token.

It was found by generating screenshots and looking at them: `node tools/smoke.mjs --shots <dir>`.
That is the reason the roadmap asks for visual verification as a separate line from the guards,
and the reason to keep asking.

---

## 8. Related

- [`00-Tokens-And-Themes.md`](./00-Tokens-And-Themes.md) — the colour layer this splits from
- [`04-Onboarding-And-Theme-Studio.md`](./04-Onboarding-And-Theme-Studio.md) — the custom
  palette editor, which is the theme axis's own escape hatch
