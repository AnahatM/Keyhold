# Onboarding and the theme studio

> Two first-contact screens with one thing in common: each is built around a single
> irreversible decision, and each is designed so the user cannot make it uninformed. Current
> reference. Implemented by `src/renderer/src/onboarding/`,
> `src/renderer/src/theme-studio/`, `src/shared/theme/keeptheme.ts` and `src/main/theme/`.
>
> **Status: both are built and tested. The theme studio is reachable; the onboarding flow is
> mount-ready and not yet mounted.** `ThemeStudio` is mounted inside `SettingsScreen`, and
> `SettingsScreen` is the `settings` tool view — reachable from the sidebar's tool rows and
> from the native **Settings** menu item through `menu-bridge.ts`. `OnboardingFlow` now owns
> the decision about when a first run is a first run (`onboarding-visibility.ts`, §3a) and
> exits on Escape as well as on Skip; what is left is the mount itself, in `App.tsx`. The
> studio's native file dialogs also remain unwired: there is no `kh:theme:*` channel, so
> `theme-file-bridge.ts` falls back to the browser transport. See §7.

---

## Part one — the first-run flow

## 1. The exact wording of the no-recovery warning

Four strings live in `onboarding-copy.ts` rather than inline in the JSX, and the reason is
that they are **claims**. A claim that exists in two places drifts, and the moment "there is
no recovery" is worded slightly differently on two screens, one of them is softer — and the
softer one is the one somebody remembers.

> **`NO_RECOVERY_HEADING`**
> There is no way to reset this password.

> **`NO_RECOVERY_EXPLANATION`**
> Keyhold has no account and no server, so there is nobody to ask and nothing to reset. If
> you forget your master password, your vault stays encrypted — for you exactly as much as
> for anyone else. Write it down and keep it somewhere physically safe.

> **`NO_RECOVERY_ACKNOWLEDGEMENT`**
> I understand: if I lose this password, I lose the vault.

> **`ENCRYPTION_CLAIM`**
> Your vault is encrypted on this device with a key derived from your master password. It is
> never uploaded anywhere, because there is nowhere to upload it to.

Why each is worded that way:

- **The heading says _reset_, not _recover_.** Every other password manager has trained
  people that a forgotten password is a mild inconvenience with a link at the bottom of the
  login form. "Reset" is the word they are looking for, so it is the word that has to be
  denied.
- **The explanation gives the mechanism before the consequence** — no account, no server,
  therefore nobody to ask — because a consequence with no mechanism reads as a policy someone
  could be talked out of. It ends with the action rather than the fear: _write it down_. That
  is genuinely the right advice; a threat model that assumes an attacker in your house is a
  different threat model from the one this app is built for.
- **The acknowledgement is first person, present tense, and states the loss rather than the
  mechanism.** It is deliberately shorter than the explanation above it, because it is the
  sentence a person has to hold in their head while ticking a box. "I understand there is no
  recovery mechanism" is a sentence about the software; "if I lose this password, I lose the
  vault" is a sentence about them.
- **The encryption claim is the only positive security claim the flow makes, and it is
  narrow.** "Encrypted on your device" is true. "Unhackable", "military grade" and "nobody can
  ever read it" are not, and the threat model says plainly what Keyhold does not defend
  against. A password manager that overstates its guarantees is worse than one that is candid,
  because people calibrate their behaviour to what they believe is true.

### The friction is correct, and it is the only friction

This is the one place in Keyhold where a checkbox stands between a user and what they want. It
stands there because the alternative — a paragraph of warning text above a Create button — is
a paragraph people scroll past and then, six months later, lose everything to. A tick is not
proof that someone read it; it is proof that they were given a moment where reading it was the
obvious thing to do, which fine print never provides.

It is not a dark pattern in the other direction: there is no guilt copy, no "are you sure you
want to be insecure", and Skip is on screen the whole time. The acknowledgement uses the same
control the ordinary create screen uses — a second styling of the single most important
checkbox in the app is how the two quietly stop matching.

The gate itself lives in `canCreateVault` and `canFinishOnboarding` in `onboarding-state.ts`,
which is pure — no React, no DOM, no storage, no clock. That is deliberate and it is why the
guarantee is testable at all: `@testing-library/react` is not a dependency of this project, so
anything expressed only as component behaviour would be effectively unguarded.

---

## 2. Five steps, in an order that is not arbitrary

| #   | Step               | Optional | Why here                                                                                                             |
| --- | ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | `welcome`          | no       | What Keyhold is, in one screen. Nobody reads a tour, so this is the only purely explanatory screen                   |
| 2   | `master-password`  | no       | The irreversible decision, taken while the user still has nothing to lose. Every gate in the flow protects this step |
| 3   | `vault-file`       | no       | Where the file is and what that means. **After** creation, so it can point at a real path rather than a promise      |
| 4   | `first-credential` | yes      | Skipping is one click                                                                                                |
| 5   | `what-next`        | yes      | Three things worth doing next, each a link out                                                                       |

`ONBOARDING_STEPS` is one exported array and nothing restates "there are five steps" or
hardcodes an order — the indicator, the reducer, the resume logic and the tests all read it,
so inserting a step inserts it everywhere. `optional` is recorded as data so the indicator can
say "optional" out loud rather than leaving the user to work out whether they may move on.

**Focus moves to the step's heading on every transition**, including the first render. That is
why no field inside a step carries `autoFocus`: two things calling `focus()` in one commit is
a race, and a skipped heading means a screen-reader user is dropped into a text field with no
idea what screen they are on. The heading is `tabIndex={-1}`, so it can receive programmatic
focus without becoming a tab stop of its own, and Tab from there lands on the first control.

**Every side effect is a callback the host passes in.** The flow owns no vault, opens no
dialog, writes no credential and navigates nowhere — so the same component can be mounted from
the app root today and from a "run the tour again" command later without either being a
special case. The skip control is rendered by the flow rather than by the steps, so it is in
the same place on every screen and cannot be forgotten by a step added later, and **Escape
dispatches the same action** — see §3a.

---

## 3. Nothing the user typed is ever persisted

`onboarding-storage.ts` writes exactly **six values**: a version, a step id, three booleans and
an outcome. It never spreads an object into the payload and never serialises a value it did
not name itself. A master password, a confirmation, a credential draft, a title, a URL — none
of them can reach `localStorage` through it, because there is no code path that would carry
them. `onboarding-storage.test.ts` plants markers in a state object to prove that holds even
when the caller hands over something with extra fields on it.

`localStorage` in a packaged Electron app is an ordinary file in the user profile, readable by
anything that can read the profile and surviving long after a vault is deleted. It is the
right place for "which step were you on" and the wrong place for anything else.

`OnboardingState` holds no typed content at all; the password and the draft live in the
component that owns the field, for exactly as long as the field is on screen.

**`acknowledgedNoRecovery` is persisted**, because it records a _decision_ rather than
content: someone who acknowledged the warning, created a vault, and then closed the app
mid-flow has already been told, and re-gating them on resume would be friction with nothing
behind it. The warning itself is still on the step when they return.

**Failure is normal, not exceptional.** Storage throws outright in some contexts, returns
stale data from an older build in others, and can be hand-edited at any time. Missing,
unreadable, corrupt, stale and self-contradictory all mean one thing: **start at the
beginning.** A first-run flow that crashes on a corrupt progress record is a first-run flow
that cannot be run at all. `PROGRESS_VERSION` is 1, and an older record is ignored rather than
migrated.

The key is **scoped per vault**, percent-encoded, because somebody setting up a second vault
should be walked through it rather than dropped at "what next" because a different vault
finished the flow last week. A vault that does not exist yet gets its own fixed
`new-vault` scope rather than an empty one, so the pending record is a named thing that can be
found and cleaned up.

The strength estimate comes from the main process's estimator, never from a second definition
invented in the renderer, and **`null` is never a pass**.

---

## 3a. When the flow shows

The flow was finished long before anything decided to render it, and that is the more
interesting half. A tour that never appears and a tour that appears to a returning user are
both silent failures: neither throws, neither fails a build, and both are found by a user.
`onboarding-visibility.ts` holds the decision, as named functions over facts rather than as a
boolean inlined at a mount site.

> **The condition: this machine has never had a vault open on it, and the flow has not already
> been finished or skipped here.**

"First run" reads like one obvious fact and is actually four candidates:

| Candidate                             | Why it is wrong                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No vault is open right now            | True at every launch, for everybody. That is the welcome screen's condition, not a first run's                                                                                                                                 |
| No `.keep` exists on this disk        | The renderer cannot look and must not learn to (D13) — and it is the wrong question anyway: a vault on a USB stick that has never been opened here genuinely _is_ a first run on this machine                                  |
| They have never seen the flow         | On its own this is a `localStorage` fact, and `localStorage` is lost to things unrelated to Keyhold's history. A long-standing user would be handed the tour again on a machine full of their vaults                           |
| **Nothing has ever been opened here** | `recentVaults` is written by the main process the moment a vault is opened — created _or_ unlocked, in `SessionController.#afterOpen` — into `preferences.json`. Empty means nobody has ever got into a vault on this computer |

`hasNeverOpenedAVaultHere` checks both `state === 'no-vault'` **and** an empty recent list, and
neither clause is redundant. `recentVaults` only gains an entry once a vault has been
_opened_, so somebody who has picked a `.keep` in the file dialog and is sitting on the unlock
screen has `state === 'locked'` and an empty recent list. That person is one password away
from their data, and covering their unlock screen with a tour about creating a vault is the
worst thing this component could do. **Nothing may put the flow in front of an unlock.**

### Where "they have already seen it" is remembered

In `localStorage`, through `onboarding-storage.ts` — and deliberately **not** as a vault
setting. Vault settings live inside the `.keep` file and travel with it, so recording
"onboarding done" there would suppress the first run on a second machine that has never shown
it. That is the same argument `preferences.ts` makes for the network kill-switch and
`appearance-store.ts` makes for the theme: a property of this machine does not belong in the
data. `localStorage` in a packaged Electron app is a file in this user's profile on this
computer, which is exactly the scope the fact has.

The pairing is what makes it robust. `localStorage` remembers the **decision**;
`recentVaults` — which no renderer can clear — remembers the **history**. Losing the first
costs at most a repeated tour; the second is what keeps that tour away from a returning user
whose profile has been wiped.

The record is read under the pending (`new-vault`) scope, because a machine that has never
opened a vault cannot have a record under any other one.

### The decision is latched for the launch

`useFirstRunGate` answers the question once, from the first session that can answer it, and
never re-asks. **This is correctness, not caching.** Creating a vault opens it, so
`recentVaults` gains its entry the instant the flow's own second step succeeds — a host that
re-derived the condition from the live session would tear the flow down at exactly that
moment, dropping the user into the vault having never been shown where their file lives.

It comes down when the flow exits, by either route, through `FirstRunGate.close`. The only way
to reopen it is a relaunch, which is also what makes a future "run the tour again" command an
explicit mount rather than an edit to this predicate.

### Escape leaves, exactly as Skip does

Both dispatch the same `dismiss` action, so they cannot come to mean different things, and
Escape is gated on `busy` for the same reason the skip button is disabled while busy — a
keyboard user must not be able to abandon a vault creation that a mouse user cannot. The
listener is on the document rather than on the panel: this surface fills the window, and a
click on its own background leaves focus on `document.body`, outside the component's subtree,
where a React `onKeyDown` would never see the key. Somebody who has just clicked the backdrop
is precisely the person reaching for Escape. An event with `defaultPrevented` set is ignored,
so a dialog opened over the flow closes itself and nothing more.

An outcome is now **terminal in both directions**: `onboardingReducer` refuses every action
once the flow is finished, `dismiss` and `complete` included. Escape is a key somebody can
still be holding as the last step lands, and letting it rewrite a _completed_ flow as
_dismissed_ would record "the user was never told anything" about a user who was told
everything.

---

## Part two — the theme studio and `.keeptheme`

## 4. Three tiers of contrast, and only one of them has no override

`admitPalette(palette, acknowledgement)` is the single gate every palette passes through
before it can be applied or exported — the same function `parseKeepTheme` uses, so a theme
cannot enter through the file door on terms the editor would refuse.

**Tier 1 — passes AA → accepted.** Nothing to decide.

**Tier 2 — fails AA but clears the legibility floor → refused, unless acknowledged.** A hard
refusal was the first instinct and it is wrong, for two reasons that are not "it's their
choice":

- _WCAG AA is a population floor, not an individual optimum._ Keyhold already ships
  `high-contrast` precisely because access needs differ. They differ in the other direction
  too: photophobia, migraine and Irlen-type sensitivity make maximum contrast genuinely
  painful, and the palette that works for such a user can fail a 4.5:1 check while being the
  _more_ accessible choice for them. An app that refuses outright is not protecting that
  person, it is overruling them.
- _A hard refusal routes around the check._ The palette is persisted in `localStorage`, and a
  determined user told "no" edits it there, or ships a patched build. They then get the theme
  with **no report, no warning and no floor** — strictly worse than the same theme admitted
  through a gate that told them exactly what was wrong. Refusing the honest path only removes
  our chance to inform.

So the choice is offered, and the burden is on the app to make it _informed_. The
acknowledgement is a token derived from the palette and the failing pairs
(`contrastAcknowledgement`), so it cannot be a remembered preference and it goes stale the
instant a colour moves — `withPalette` in the draft reducer clears it on **every** palette
change, in one place, so no future action can forget to invalidate it. It is impossible to
give without the failing pairs having been computed, because the studio renders them, named
and rated, before the checkbox that produces the token exists. _"It's their choice"_ is only
an acceptable answer once the choice is real, and a choice made without seeing the
consequences is not.

**Tier 3 — fails the legibility floor → refused outright. There is no override.** Consent to
a bad theme is real; consent to a theme that traps you is not, **because you cannot revoke
it**. A palette with `text` at 1.4:1 on `bg` leaves a user unable to read the Settings screen
that would undo it, so the decision becomes irreversible at the moment it is made — which is
the one thing genuine consent cannot survive. The same reasoning is why the app ships no
"auto-lock: never" that cannot be turned back on.

`ESCAPE_FLOOR_MINIMUM` is **3:1**, WCAG 2.2 SC 1.4.11's floor for a UI component boundary.
Below it, body text on a surface is not "low contrast", it is approaching invisible.

`ESCAPE_FLOOR_REQUIREMENTS` is four pairs — **a subset of `CONTRAST_REQUIREMENTS` at a lower
bar, not a second list.** The same pairs, re-stated with the different question they answer:
`CONTRAST_REQUIREMENTS` asks _is this comfortably readable?_, these four ask _can you still
find Settings and change it back?_

| Pair                       | Because                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `text` on `bg`             | Below this the app is unreadable, not merely uncomfortable                                                                           |
| `text` on `surface`        | Settings is a panel                                                                                                                  |
| `text` on `surface-raised` | The confirmation that undoes the theme is a dialog                                                                                   |
| `focus-ring` on `bg`       | A keyboard-only user with no visible focus indicator cannot reach the control that would fix the theme, however readable the text is |

`keeptheme-format.test.ts` asserts every pair here is also declared in `tokens.ts`, so dropping
one there cannot leave a floor pair orphaned.

---

## 5. `.keeptheme` is deliberately not CSS

A `.keeptheme` holds no vault data and never should — a name, a description, a scheme, a base
theme, and a map of the token vocabulary to colour literals. It is not encrypted because there
is nothing in it worth encrypting, and that is a stated property rather than an omission:
people are expected to post these on the internet and hand them to each other.

The obvious design is to let a theme be a stylesheet and paste it into a `<style>` element.
Every part of that is wrong here:

- **CSS is executable in the ways that matter.** `url()` fetches, `@import` fetches,
  `image-set()` fetches — and this app makes zero network requests by design (hard rule 5).
  A stylesheet can also restyle or hide any element in the app, including the parts of
  Settings a user would need to undo the theme. A theme file from a stranger must not be able
  to reach the network or move the furniture.
- **`var()` chains and `calc()` are computation.** A value that resolves at paint time cannot
  be contrast-checked before it is applied, which is exactly the guarantee the gate exists to
  preserve. A ratio can only be measured against a concrete colour.
- **A stylesheet has no schema.** "Which tokens are missing" is unanswerable, so a theme with
  three tokens missing renders as an app with three invisible elements and looks broken rather
  than incomplete.

So the format is a fixed set of token names mapping to validated colour literals, and nothing
else. Anything unrecognised is dropped, and — the part that matters most — **every accepted
colour is re-serialised from parsed RGB into `#rrggbb`** before it can reach a stylesheet. The
string that eventually lands in `style.setProperty` is one _we_ wrote, not one the file
supplied, so even a bug in the validator cannot become a CSS injection.

### What a hostile file is checked for, in order

| Problem                           | Response                                                     |
| --------------------------------- | ------------------------------------------------------------ |
| Not JSON, or not an object        | Rejected                                                     |
| Wrong `format` marker             | Rejected                                                     |
| Newer `version`                   | Rejected, **naming the version** — never mis-parsed as v1    |
| Bad name or scheme                | Rejected, naming the field                                   |
| Unknown token                     | **Ignored, with a warning naming it**                        |
| Missing token                     | **Filled from the named base theme, with a warning**         |
| Unparseable or translucent colour | **Rejected, naming every offending token** — never defaulted |
| Fails WCAG AA                     | Rejected unless explicitly and informedly acknowledged (§4)  |
| Fails the legibility floor        | Rejected. No override exists                                 |

The missing/unparseable split is the interesting one. An **absent** key is a theme that is
incomplete — possibly on purpose, and certainly the shape a v1 file will have when a later
Keyhold adds a token — so it is filled from the base and reported. A **present but broken**
value is an author mistake, and silently replacing it would hide the typo while shipping a
colour the author never chose.

`KEEPTHEME_MAX_BYTES` is 64 KB, against a complete theme of roughly 1.5 KB: generous by two
orders of magnitude and still small enough that a malicious multi-megabyte "theme" is refused
before `JSON.parse` is asked to allocate it. Names cap at 80 characters, descriptions at 240,
and a colour literal at 32 — anything longer is not a colour, whatever it is.

---

## 6. The studio: a two-layer palette, a live report, and one gate

**The contrast report is not behind a tab or a button.** It is on screen beside the editor and
recomputes on every change, and the gate below _Apply_ and _Export_ is derived from
`admitPalette` — the same function the file parser uses — so a failing theme cannot leave the
screen unless the user has ticked a box whose label names the failures.

**The palette has two layers.** `palette` only ever holds canonical `#rrggbb` values; what the
user is currently typing lives in `typing` and moves into `palette` only when it parses. That
is what lets a field show "not a colour" mid-keystroke instead of the preview flickering
through the meaningless intermediate states of `#`, `#3`, `#33` — the same reasoning
`accent.ts` gives for returning `null` rather than throwing.

The draft reducer is pure and lives outside the components, so what a bad colour does, when an
acknowledgement goes stale, and what "Reset" means are all testable without rendering
anything.

**`TOKEN_GROUPS` is presentation, not a second vocabulary.** Eight groups arrange the token
list, and `token-groups.test.ts` asserts they cover `COLOUR_TOKENS` **exactly once each** — so
adding a token to `tokens.ts` without placing it here is a test failure rather than a token
that silently becomes uneditable, which is the failure mode a hand-maintained UI list always
has. Status colours are split into four groups rather than one because they are read one at a
time: somebody adjusting "danger" is looking at three related values, not at twelve.

### Applying a custom palette pins a matching base theme

A custom palette takes its `color-scheme` from the _named_ theme rather than from itself, so
`applyToApp` pins a theme whose scheme matches the draft's — falling back to the default light
or dark theme when the base disagrees. Otherwise a light custom palette would render dark
native controls. It also clears any stored `accentColour`, because the draft already contains
whatever accent the user derived and leaving one set would re-derive over the top of it on the
next resolve.

### The report panel is itself accessible

- **Pass and fail are words, never colour alone.** Green and red rows in a panel _about
  colour contrast_ would be a WCAG 1.4.1 failure in the most embarrassing possible place, and
  unreadable to exactly the users the panel serves. Every row carries the word and a symbol;
  the tint is the third signal.
- **There is no live region.** The obvious instinct is `aria-live` on the summary. In practice
  the report recomputes on every frame of a colour slider, and a polite live region tied to a
  drag announces continuously and drowns everything else out. The summary is a static heading,
  re-read on demand.
- **The panel does no arithmetic of its own.** Ratios come from `evaluatePaletteContrast`, the
  same function the gate uses — if it computed its own, it could tell the user a theme passes
  while the gate refuses it.
- **Failures sort first**, then everything else in declaration order. Someone opening this
  panel is looking for what is wrong, and making them scroll for it is the whole problem.

### A theme is the one file the renderer may handle itself

Everything else in Keyhold goes through the main process because the main process owns the
keys and the decrypted vault (decision D13). A `.keeptheme` is the deliberate exception, and it
is worth stating rather than leaving to look like a hole: it holds **no secret material**, it
is not encrypted, and it is meant to be shared.

`theme-file-bridge.ts` therefore has two transports and one behaviour: **native**
(`window.keyhold.theme.*`, native dialogs, the size cap enforced by `stat` before a byte is
read) and **browser** (a plain `<input type="file">` and a blob download — standard web APIs,
no Node, no new dependency). The user picking a file in the OS dialog is the same act of
consent either way. The bridge moves **raw text only**; `parseKeepTheme` runs once, in the
studio, so the two transports cannot validate differently — and so the acknowledgement round
trip does not need a process hop per attempt.

The main-process half deliberately does **not** reuse `writeVaultFileAtomically`. That
function rotates `.keepbak` backups, creates files `0o600`, and quarantines orphaned temps on
the next launch — all three wrong for a theme, which is meant to be readable by the user's
other tools and shared with other people. What is kept is the ordering: write, fsync, rename,
so a crash mid-write cannot leave a half-written theme where a whole one used to be. Only a
basename ever crosses back; an OS error carries the absolute path and is never echoed.

---

## 7. Not built yet

- **`OnboardingFlow` is not mounted.** Roadmap Phase 16 still lists "first-run onboarding
  tour, skippable and re-runnable" as outstanding, which is true of the _wiring_ and no longer
  true of the code. The decision about when to show it is now built and tested (§3a) —
  `useFirstRunGate(status)` is the whole question — so what is left is one edit in `App.tsx`:
  render `OnboardingFlow` instead of `ScreenView` while the gate is open, and supply the
  callbacks.
- **Three of the flow's callbacks have nowhere to go yet, by choice.** `onImport`,
  `onEnableQuickUnlock` and `onOpenAutoLockSettings` open tool views that only exist inside
  the unlocked vault screen, so wiring them from the first-run flow would open a panel behind
  the flow — a dead control. Left absent, each card renders the fallback sentence naming where
  the thing lives, which is honest. Likewise `onRevealInFolder`: there is no `kh:shell:*`
  channel to reveal a path in the file manager.
- **"Run the tour again"** — the flow is written so this costs nothing (every side effect is a
  passed-in callback), and there is no command or menu item for it. It would be an _explicit_
  mount rather than a change to the first-run predicate: re-opening the gate would mean
  `clearProgress` **and** `forgetFirstRunDecision()`, and it would still refuse on a machine
  that has a vault — correctly, because that is not a first run. The command palette is mounted
  now, so there is somewhere to put one; nothing has been put there.
- **The native theme dialogs are unwired.** There is no `kh:theme:*` entry in `CHANNELS`;
  `src/main/theme/` (`readKeepThemeFile`, `writeKeepThemeFile`, `chooseKeepThemeToOpen`,
  `chooseKeepThemeDestination`, `importKeepTheme`, `exportKeepTheme`) is complete and has no
  handler. `theme-file-bridge.ts` probes for `window.keyhold.theme` structurally and falls back
  to the browser transport, so the studio works today over `<input type="file">` and picks the
  native route up on its own when the channels land — the only edit needed then is to the
  `KeyholdApi` type, so the cast in the bridge can be deleted.
- **A dedicated tag colour family.** Both tag-colour modules record that
  `--kh-color-tag-1 … tag-n` tokens in `tokens.ts`, each with a contrast requirement, are the
  right answer — the existing guard would then cover them for free. See
  [`../05-Features/06-Organisation.md`](../05-Features/06-Organisation.md) §9.
- **Sharing or discovering themes** — there is no gallery, no bundled example `.keeptheme`,
  and no import from a URL (there could not be one: hard rule 5).

---

## 8. Tests

| File                                                        | Tests | Covers                                                                                                                                                          |
| ----------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/theme/keeptheme-format.test.ts`                   | 41    | Every built-in round-tripping exactly · every category of hostile or broken file · the three admission tiers · that every floor pair is declared in `tokens.ts` |
| `src/renderer/src/onboarding/onboarding-state.test.ts`      | 24    | The gates — `canCreateVault` and `canFinishOnboarding` — step arithmetic, resume reconciliation, and that an outcome is terminal                                |
| `src/renderer/src/onboarding/onboarding-visibility.test.ts` | 22    | The show/hide condition in every session state · that nothing may cover an unlock screen · the launch latch · that a dismissal survives a restart               |
| `src/renderer/src/theme-studio/theme-draft.test.ts`         | 23    | The two-layer palette, invalid colours, and that every palette change clears the acknowledgement                                                                |
| `src/renderer/src/theme-studio/theme-file-bridge.test.ts`   | 17    | Both transports, the size cap, and the cancelled/failed outcomes                                                                                                |
| `src/renderer/src/onboarding/onboarding-storage.test.ts`    | 16    | That only the six named values are written, with markers planted to prove it · every corrupt-record path starting at the beginning                              |
| `src/main/theme/keeptheme-file.test.ts`                     | 13    | `stat`-before-read, the write ordering, and that no path reaches an error message                                                                               |
| `src/renderer/src/onboarding/OnboardingFlow.test.tsx`       | 13    | Sequencing, focus on the heading, the skip control, and Escape — from every step, after a backdrop click, never while busy, never over a handled event          |
| `src/renderer/src/theme-studio/token-groups.test.ts`        | 5     | That the groups cover `COLOUR_TOKENS` exactly once each                                                                                                         |

---

## 9. Related

- [`00-Tokens-And-Themes.md`](./00-Tokens-And-Themes.md) — the token vocabulary, the eight built-in themes, the accent derivation, and `CONTRAST_REQUIREMENTS`
- [`01-Layout-And-Components.md`](./01-Layout-And-Components.md) — the shell these screens sit inside
- [`03-Command-Palette-And-Shortcuts.md`](./03-Command-Palette-And-Shortcuts.md) — where a "run the tour again" command would live
- [`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) — what the encryption claim may and may not say
- [`../02-Security/02-Session-Model.md`](../02-Security/02-Session-Model.md) — the create-vault path that carries the same acknowledgement
- [`../12-Roadmap/02-Decision-Log.md`](../12-Roadmap/02-Decision-Log.md) — D8 (theming) and D13 (why a `.keeptheme` is the one file the renderer may touch)
