// SPDX-License-Identifier: GPL-3.0-or-later
import './icon.css';

/**
 * The icon set — hand-drawn SVG, not emoji and not a library.
 *
 * ## Why not emoji
 *
 * Emoji were the placeholder and they were the wrong answer for four reasons, in the order
 * they matter:
 *
 * 1. **They are somebody else's artwork.** A 🔒 is rendered by the OS font — Segoe UI Emoji on
 *    Windows, Apple Color Emoji on macOS — so the same screen looks like two different apps
 *    on two machines, and neither looks like *this* one.
 * 2. **They ignore the theme.** An emoji is full-colour and fixed. It cannot take
 *    `currentColor`, so it cannot follow a palette, an accent, or a style — which is the
 *    entire premise of the design system it was sitting inside.
 * 3. **They are read aloud.** A screen reader announces "locked with key" for 🔒, in the
 *    middle of a sentence that already said what the row is. Every icon here is
 *    `aria-hidden`, because every one of them sits beside real text.
 * 4. **Coverage is not guaranteed.** 🗝 and 🗀 have no glyph in several common fonts and
 *    render as a replacement box — a missing icon that looks like a bug.
 *
 * ## Why not an icon library
 *
 * A new dependency, for a set this small, in an app whose whole pitch is that it ships no
 * more than it needs. Roughly thirty glyphs of simple geometry is an afternoon of drawing and
 * zero bytes of supply chain — and a library would still have to be re-themed to
 * `currentColor` and re-audited for the aria behaviour above.
 *
 * ## How they are drawn
 *
 * One 24×24 grid, stroked rather than filled, `currentColor` throughout, and no `fill`
 * anywhere except where a shape is genuinely solid. Stroke width is a token so a style can
 * make the set lighter without redrawing it. Consistency of grid and weight is what makes a
 * hand-made set read as a set rather than as a collection.
 *
 * `vector-effect: non-scaling-stroke` is deliberately **not** used: these are rendered at one
 * or two sizes and letting the stroke scale with the box is what keeps a large icon from
 * looking spindly.
 */

export type IconName =
  // ── State and feedback ────────────────────────────────────────────────────
  | 'warning'
  | 'check'
  | 'close'
  | 'info'
  /**
   * One chevron, pointing right, rotated by CSS wherever it needs to point elsewhere.
   *
   * Four separate arrow icons would be four drawings to keep in step, and a folder twisty
   * that *rotates* is telling the user the two states are the same control — which four
   * static glyphs cannot say. The rotation belongs on the element, not in here.
   */
  | 'chevron'
  // ── Secrets ───────────────────────────────────────────────────────────────
  | 'reveal'
  | 'hide'
  | 'lock'
  | 'unlock'
  | 'key'
  | 'shield'
  | 'clipboard'
  // ── The vault's furniture ─────────────────────────────────────────────────
  | 'vault'
  | 'star'
  | 'trash'
  | 'folder'
  | 'folders'
  | 'document'
  | 'tag'
  | 'clock'
  | 'search'
  // ── Actions and tools ─────────────────────────────────────────────────────
  | 'import'
  | 'export'
  | 'save'
  | 'settings'
  | 'wrench'
  | 'parcel'
  | 'device'
  | 'offline'
  | 'bolt'
  | 'free'
  /**
   * The six the emoji sweep asked for, each because nothing already in the set said the
   * thing honestly. They are here rather than approximated, because an icon that nearly
   * means what the label says is worse than one that plainly does not: a reader trusts it
   * and is wrong.
   */
  | 'undo'
  | 'swap'
  | 'list'
  | 'blocked'
  | 'minus'
  | 'power';

/**
 * The paths, on a 24×24 grid.
 *
 * Written out rather than generated so each one can be read and adjusted. Every shape is
 * centred in the box and sized to about 18px of it, so icons of different silhouettes still
 * look the same weight beside each other.
 */
const PATHS: Readonly<Record<IconName, React.ReactNode>> = {
  warning: (
    <>
      <path d="M12 4.5 21 19.5H3z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevron: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  close: (
    <>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.75h.01" />
    </>
  ),

  // An eye. The pupil is a filled circle rather than a stroked one so it reads at 14px,
  // where a 2px ring closes up into a dot anyway.
  reveal: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </>
  ),
  // The same eye with a stroke through it, which is the convention people already read as
  // "hidden" — rather than a second, unrelated shape.
  hide: (
    <>
      <path d="M3.5 8.5C5.7 6.4 8.6 5.5 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 3.9" />
      <path d="M15.5 17.7c-1.1.5-2.3.8-3.5.8-6 0-9.5-6.5-9.5-6.5a17 17 0 0 1 2.6-3.4" />
      <path d="m4 4 16 16" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  // The same body with the shackle swung open, so locked and unlocked are the same object.
  unlock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9" />
      <path d="M17.5 12v3.5" />
      <path d="M20.5 12v2.5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 19.5 6v6c0 4.4-3 7.6-7.5 9-4.5-1.4-7.5-4.6-7.5-9V6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  clipboard: (
    <>
      <rect x="6" y="4.5" width="12" height="16" rx="2" />
      <path d="M9.5 4.5V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1Z" />
    </>
  ),

  // A vault door: a rounded square with a dial. Not a padlock — the sidebar already uses a
  // padlock for the lock state, and two padlocks meaning different things is worse than none.
  vault: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 8.5v-1" />
      <path d="M12 16.5v1" />
    </>
  ),
  star: <path d="m12 4 2.5 5.2 5.5.8-4 4 .9 5.5L12 16.9 7.1 19.5l.9-5.5-4-4 5.5-.8Z" />,
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
      <path d="M6.5 7v12.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V7" />
      <path d="M10.5 11v6" />
      <path d="M13.5 11v6" />
    </>
  ),
  folder: (
    <path d="M3.5 6.5a1 1 0 0 1 1-1h4.2l2 2.5h8.8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z" />
  ),
  folders: (
    <>
      <path d="M7 4.5h3.2l1.6 2h6.7a1 1 0 0 1 1 1v2" />
      <path d="M3.5 9.5a1 1 0 0 1 1-1h4.2l1.6 2h8.7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z" />
    </>
  ),
  document: (
    <>
      <path d="M6.5 3.5h7l4.5 4.5v12a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path d="M13.5 3.5V8h4.5" />
    </>
  ),
  tag: (
    <>
      <path d="M4 11.6V5a1 1 0 0 1 1-1h6.6a1 1 0 0 1 .7.3l7.4 7.4a1 1 0 0 1 0 1.4l-6.6 6.6a1 1 0 0 1-1.4 0L4.3 12.3a1 1 0 0 1-.3-.7Z" />
      <circle cx="8.5" cy="8.5" r="1.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.2 2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),

  // Import and export are the same tray with the arrow reversed, because they are the same
  // operation in two directions and drawing them as unrelated shapes would hide that.
  import: (
    <>
      <path d="M12 3.5v10" />
      <path d="m8 9.5 4 4 4-4" />
      <path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
    </>
  ),
  export: (
    <>
      <path d="M12 13.5v-10" />
      <path d="m8 7.5 4-4 4 4" />
      <path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
    </>
  ),
  save: (
    <>
      <path d="M4.5 5.5a1 1 0 0 1 1-1h11L19.5 7.5v11a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1Z" />
      <path d="M8 4.5v5h8v-5" />
      <path d="M8 19.5v-6h8v6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.6M12 18.6v2.6M4.5 12H2M22 12h-2.5M6.3 6.3 4.5 4.5M19.5 19.5l-1.8-1.8M17.7 6.3l1.8-1.8M4.5 19.5l1.8-1.8" />
    </>
  ),
  wrench: (
    <path d="M20 5.5a5 5 0 0 1-6.6 6.6L6 19.5a2.1 2.1 0 0 1-3-3l7.4-7.4A5 5 0 0 1 17 2.5l-3.2 3.2 1.5 1.5L18.5 4Z" />
  ),
  parcel: (
    <>
      <path d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5Z" />
      <path d="m3.5 8.5 8.5 4.5 8.5-4.5" />
      <path d="M12 13v7" />
    </>
  ),
  device: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
      <path d="M8.5 20.5h7" />
      <path d="M12 16.5v4" />
    </>
  ),
  // A plug pulled out — the app's one picture of "no network", and it has to read at a glance
  // because it is making a promise rather than describing a state.
  offline: (
    <>
      <path d="M9 7.5V3.5" />
      <path d="M15 7.5V3.5" />
      <path d="M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0Z" />
      <path d="M12 16.5v4" />
      <path d="m4 4 16 16" />
    </>
  ),
  bolt: <path d="M13.5 2.5 5 13.5h5.5L10 21.5 19 10.5h-5.5Z" />,
  free: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 8.5h5.5" />
      <path d="M9 12h4" />
      <path d="M9 8.5v7" />
    </>
  ),

  // An arrow curving back on itself: the import's "this was undone" row.
  undo: (
    <>
      <path d="M4 9.5h10a5.5 5.5 0 0 1 0 11h-6" />
      <path d="m7.5 5.5-3.5 4 3.5 4" />
    </>
  ),
  // Two arrows passing: a value that arrived changed rather than intact.
  swap: (
    <>
      <path d="M4.5 8.5h13" />
      <path d="m14 5 3.5 3.5L14 12" />
      <path d="M19.5 15.5h-13" />
      <path d="M10 12l-3.5 3.5L10 19" />
    </>
  ),
  // Stacked rules: structure flattened into lines.
  list: (
    <>
      <path d="M8.5 7h11" />
      <path d="M8.5 12h11" />
      <path d="M8.5 17h11" />
      <path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
    </>
  ),
  // A circle with a bar through it: excluded, rather than merely absent.
  blocked: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" />
    </>
  ),
  // The quietest mark the set has, for the lowest severity. A triangle shouts, a circle
  // informs, and a bar is a note — three shapes that differ without colour, which is what
  // WCAG 1.4.1 asks of a severity scale.
  minus: <path d="M6.5 12h11" />,
  // The standard power mark, for a rule that is switched off.
  power: (
    <>
      <path d="M12 4v8" />
      <path d="M7.1 7.1a7 7 0 1 0 9.8 0" />
    </>
  ),
};

export interface IconProps {
  readonly name: IconName;
  /**
   * Sized in `em` so an icon scales with the text beside it.
   *
   * A pixel size would mean an icon that stays put while the font-size setting moves the
   * label next to it, which is the specific way icon sets stop lining up.
   */
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
}

/**
 * `aria-hidden` with no exception, and that is a design constraint rather than a default.
 *
 * Every icon in this app sits beside text that already says what the thing is. An icon that
 * announced itself would make a screen reader read every row twice. If a control ever needs
 * an icon *instead* of a label, the label goes on the control as `aria-label` — never on the
 * glyph.
 */
export function Icon({ name, size = 'md', className }: IconProps): React.JSX.Element {
  return (
    <svg
      className={`kh-icon kh-icon--${size}${className === undefined ? '' : ` ${className}`}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="var(--kh-icon-stroke)"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
