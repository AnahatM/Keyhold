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

### The fourth region: tool views

`AppShell` has a second mode. Supply its `main` prop and the list and detail step aside for
as long as it is supplied, leaving the sidebar in place.

```
┌─────────┬─────────────────────────────────┐
│ sidebar │  main  — the open tool view      │
│         │                                  │
│ views   │  health · generator ·            │
│ folders │  settings · help                 │
│ tags    │                                  │
│ tools ◄─┤  (the row that opened it)        │
└─────────┴─────────────────────────────────┘
```

The three-pane shell answers one question: _which record?_ Four finished screens answer
questions that are not about a record at all — how healthy is this vault, make me a password,
what are my settings, how does this thing work — and none of them fits in a pane sized for a
credential. Squeezing the health dashboard into the detail column, or the two-column help
viewer into a 320px list, is how a finished screen ends up looking unfinished.

Three things make this a mode of an existing idea rather than a new one:

- **The sidebar stays.** It holds the rows that opened the tool, so the way back out is never
  off-screen.
- **It is the same shape the narrow layout already uses**, where the detail pane takes over
  from the list.
- **It is additive.** The three-pane path is untouched when `main` is `undefined`, so nothing
  about the existing layout depends on a mode flag being read correctly.

**The definitions are a table, not a switch** — `src/renderer/src/shell/tool-views.ts`, hard
rule 8. Four things have to agree about what a tool view is: the sidebar row that opens it, the
`<h1>` at the top of it, the component `VaultScreen.tsx` mounts, and the native menu command in
`src/main/shell/menu-commands.ts` that will trigger it. A definition in the table carries no
component and no behaviour, exactly like `command-registry.ts`: it is importable from a test and
diffable when someone adds a tool. `VaultScreen.tsx` supplies the mounting in one exhaustive
`switch` that TypeScript refuses to compile if a new id is left out, and `tool-views.test.ts`
checks the `menuCommandId`s are unique.

The title is one string used twice — the page heading _and_ the sidebar row's label — because a
nav row reading "Generate" that lands on a page titled "Password tools" is the small kind of
drift nothing ever tests.

`menuCommandId` is a plain string rather than an imported union because the main process cannot
import from `src/renderer`; the two halves are separate TypeScript programs, deliberately.
Naming the commands back here is what makes the bridge a **lookup** rather than a third copy of
the mapping written inside an IPC listener.

That bridge exists: `src/main/index.ts` forwards an unhandled menu or tray command as
`kh:event:menu-command`, and `src/renderer/src/shell/menu-bridge.ts` — started once from
`App.tsx`, not mounted per screen, because a menu click can arrive while a screen is being
replaced — asks `toolViewForMenuCommand` first and only then falls back to a small `switch` for
the palette and the shortcut sheet. A command with nowhere to go is **logged, not swallowed**:
the main process only forwards commands it has already decided are enabled, so one arriving
unhandled means the two sides disagree about what this build can do. `vault.import` and
`vault.export` are exactly that case today.

A menu item opens rather than toggles. Someone who picks "Vault health" from a menu while
already looking at it meant to go there, and having it close instead reads as the click having
missed.

**`settings` was briefly absent from this table**, and why is worth keeping. `SettingsScreen`
was written and mount-ready, but its gateway still refused every read with "Phase 14 has not
registered `kh:settings:read`" — a renderer-side stub written before the channel existed and
left behind after it did. The row rendered nothing but an error page, and a permanent sidebar
entry that only ever fails is worse than one that is not there yet. The gateway is wired now,
and `settings-gateway.test.ts` fails if an entry in its `REQUIRED_CHANNELS` names a channel the
contract already has — which is what stops the same gap from re-opening quietly the next time a
channel lands.

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

`src/main/shell/` — `menu-template.ts` builds it, `menu-model.ts` holds the shape, and
`menu-commands.ts` is the command table both halves name. Worth building properly rather than
hiding, for three reasons:

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

| Component                       | Status                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select, Switch                  | **Built**, with the settings screen that needed them — `SettingSelect` and `SettingSwitch` in `src/renderer/src/settings/SettingControls.tsx`. Deliberately not generic: they carry a scope badge and a trade-off note, because that is what every row of that screen needs |
| Radio                           | Still not built. Nothing has yet wanted one that a `SettingSelect` did not serve better                                                                                                                                                                                     |
| Tabs, Card, Chip                | Still not built. The credential detail view was written without them                                                                                                                                                                                                        |
| Tooltip, Modal, Toast, Progress | **Built** — `src/renderer/src/chrome/`. See [`02-App-Chrome.md`](./02-App-Chrome.md)                                                                                                                                                                                        |
| Menu (an in-page one)           | Still not built. The native menu bar covers what it would have                                                                                                                                                                                                              |
| The custom theme editor UI      | **Built** — `src/renderer/src/theme-studio/`, mounted inside `SettingsScreen`. See [`04-Onboarding-And-Theme-Studio.md`](./04-Onboarding-And-Theme-Studio.md)                                                                                                               |
| The system tray                 | **Built** — `src/main/shell/tray.ts` and `tray-model.ts`                                                                                                                                                                                                                    |

The rule this table exists to record still holds, and it is the reason the built rows read the
way they do: **a component with no caller is a component designed against a guess.** Every one
of the "built" entries was written with the screen that needed it, and `SettingSelect` is the
clearest illustration — asked for in the abstract it would have been a generic `<Select>`, and
what settings actually needed was a row that carries a scope badge and a trade-off note.

---

## 5. Related

- [`00-Tokens-And-Themes.md`](./00-Tokens-And-Themes.md) — the colour system and its guards
- [`../01-Architecture/00-Process-Model.md`](../01-Architecture/00-Process-Model.md) — what the renderer is allowed to hold
