# Layout & components

> The three-pane shell, the native chrome, and the rules every component follows.
> Current reference.

---

## 1. The shell

Three panes, both sides collapsible (decision D7) — the pattern 1Password, Bitwarden and
Apple Passwords all independently converged on.

```
┌─────────┬──────────────┬──────────────────┐
│ sidebar │  list        │  detail          │
│         │              │                  │
│ views   │  virtualised │  fields, history │
│ folders │  credentials │  actions         │
│ tags    │              │                  │
└─────────┴──────────────┴──────────────────┘
   ↕ drag        ↕ drag
```

### It degrades rather than breaks

| Window width | Layout                                                                     |
| ------------ | -------------------------------------------------------------------------- |
| ≥ 900px      | All three panes                                                            |
| 680–900px    | Sidebar + **either** list or detail — they take turns, with a Back control |
| < 680px      | One pane at a time; the sidebar collapses too                              |

A credential manager is very often a narrow window parked beside whatever you are actually
doing, so the narrow case is a **normal case, not an edge case**. Squeezing three columns
into 700px would make all three unusable; dropping one keeps the rest correct.

### Dividers are keyboard-operable

Each divider is a real `role="separator"` with `aria-valuenow`/`min`/`max`, `tabIndex={0}`,
and arrow-key handling (Shift for a larger step). A divider that only responds to a mouse
drag is a divider a keyboard user cannot move at all.

Widths persist to `localStorage`; the drag adds a class to `<body>` so the resize cursor
holds for the whole gesture instead of flickering as the pointer crosses child elements.

---

## 2. Native chrome

### Window state

`src/main/window-state.ts` remembers size, position and maximised state.

The part that is actually easy to get wrong is the **restore**. A saved position is only
valid for the display arrangement it was saved on. Someone works on a laptop with an
external monitor, closes Keyhold with the window on that monitor, unplugs it, and reopens —
and the window is restored to coordinates that no longer correspond to any screen. It is
invisible, unreachable, and indistinguishable from a crash.

`isVisibleOnSomeDisplay` requires at least 120px of overlap with some current display
before a saved position is trusted; otherwise x/y are dropped and Electron centres the
window, which is always reachable. Fault-injected: removing the check fails three tests.

Two smaller details: writes are debounced (a resize drag fires hundreds of events, and a
torn file is a real risk if the app is killed mid-drag), and `getNormalBounds` is used
rather than `getBounds` so a maximised window remembers its pre-maximised size — otherwise
un-maximising restores it to full screen and it can never be made small again.

### The menu

`src/main/menu.ts`. Worth building properly rather than hiding, for three reasons:

- **It is the discoverable list of every keyboard shortcut.** A command palette is faster
  once you know a command exists; the menu is how you find out it exists.
- **It is how screen-reader users navigate an app's commands.** Replacing it with a custom
  hamburger removes an accessibility route entirely.
- **macOS and Windows genuinely differ.** The app menu, the Window menu, and the position
  of Settings and Quit are platform conventions, not preferences. Preferences under
  `Cmd+,` in the app menu on macOS; under `Ctrl+,` in File on Windows.

Vault-affecting items are **disabled while locked** rather than present and failing — a
menu item that silently does nothing is worse than one that is visibly unavailable.

Devtools appear only in development, matching `security.ts`, which also closes them if
they are opened another way in a packaged build.

---

## 3. Component rules

Rules, not conventions. Each exists because of a specific failure.

### Labels are required, not optional

`Input` takes `label: string` — mandatory in the type. A placeholder is not a label: it
disappears the moment someone types, it is invisible to many screen readers, and it fails
WCAG 3.3.2. `labelHidden` keeps it for assistive tech when the visual design does not want
it.

`Button` has a separate `iconOnlyLabel` prop. An icon-only button with no accessible name
is announced as "button" and nothing else. Making it a distinct prop is a prompt at the
call site rather than a rule someone has to remember.

### Never colour alone

WCAG 1.4.1, and it matters most in exactly the place this app cares about — the health
dashboard, where the whole point is flagging problems:

- `Badge` takes a `symbol` alongside its tone (`✓`, `!`, `✕`).
- Field errors render a `⚠` before the message.
- A selected theme card gets a border **and** a tick.
- A selected accent swatch gets a ring **and** a size change.
- Segmented options carry `aria-pressed` **and** a fill **and** a weight change.

### Every view has three states

`EmptyState`, `LoadingState` and `ErrorState` live in one file because they are one
decision, not three. A view shipped with a list but no empty state shows a blank rectangle
the first time anyone opens it — the single most common way an otherwise finished app feels
unfinished.

Empty states say **what to do next**, not just that there is nothing.

`LoadingState` uses skeletons rather than a spinner: they reserve the right amount of
space, so nothing jumps when real content lands. The layout-shift problem, solved by not
creating it.

### Focus is `:focus-visible`, never `:focus`

A visible ring on every mouse click is noise that trains people to ignore it. The ring is
the **only** way a keyboard user knows where they are, and it is the last thing that should
ever be turned off.

Text fields are the exception: `:focus-within` on the wrapper, because clicking into a text
field genuinely should show where focus went — and putting the ring on the wrapper means it
surrounds the trailing controls too.

### The window never scrolls

`body` is `overflow: hidden` and `user-select: none` — this is an app, not a page.
Selection is restored on inputs and anything marked `data-selectable`. Wide content scrolls
inside its own container.

---

## 4. What is deliberately not built yet

Recorded here rather than left implied. Each is written when the phase that needs it
arrives, because a component with no caller is a component designed against a guess:

| Component                   | Arrives with                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select, Switch, Radio       | Phase 14 — settings                                                                                                                                       |
| Tabs, Card, Chip            | Phase 5 — the credential detail view                                                                                                                      |
| Tooltip, Menu, Modal, Toast | Phase 15 — the chrome and quality-of-life systems                                                                                                         |
| The custom theme editor UI  | Phase 14. The model, contrast maths, validation and `.keeptheme` import/export are **already built and tested** — only the editing surface is outstanding |
| The system tray             | Phase 15, alongside the lock and quick-action commands it would contain                                                                                   |

---

## 5. Related

- [`00-Tokens-And-Themes.md`](./00-Tokens-And-Themes.md) — the colour system and its guards
- [`../01-Architecture/00-Process-Model.md`](../01-Architecture/00-Process-Model.md) — what the renderer is allowed to hold
