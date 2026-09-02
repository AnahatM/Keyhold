# App chrome

> Toasts, modals, tooltips, progress and empty states — the layer that decides whether the
> app feels finished. Current reference. Implemented by `src/renderer/src/chrome/`.
>
> **Status: built and mounted. The global shortcut table, the command palette and the image
> lightbox are separate Phase 15 items and are not here.** See §7.

---

## 1. Why this is a layer rather than five components

Every one of these is small on its own and collectively they are what separates an app from
a form. They also share one property: each is a **timing** problem more than a rendering
problem — how long a toast lives, when a tooltip opens, when focus returns — and timing is
where they go wrong.

So the arithmetic is pure and separately tested: `toast-queue.ts`, `tooltip-timing.ts`,
`progress.ts`, `focus.ts`. The components render what those decide.

---

## 2. Toasts

### The queue policy: coalesce, cap, bound

Three layers, in that order, because each absorbs a different kind of flood.

1. **`dedupeKey` collapses repeats in place** — "Copied ×7" — and restarts the clock. This
   is what actually absorbs a user hammering a copy button.
2. **Three visible**, the rest queued. More than three and the newest is off-screen, which
   is the same as not showing it.
3. **Eight queued**, evicting the **oldest expiring** entry. Twenty toasts in a burst give
   three visible, eight queued, and a quiet "+8 more".

### Two kinds of toast never dismiss themselves

An **undo** toast and an **error** toast both stay until acted on.

An undo that vanishes before it is read is not an undo — it is a deletion with a decorative
animation. And "Save failed" sliding away is exactly how a user concludes their save
succeeded.

That makes _persistent_ the protected category: a persistent toast displaces an ordinary
visible one rather than queueing behind it, and is never the entry evicted while an
expiring one exists. Taking the action dismisses the toast — a second press of Undo would
be a redo of the deletion.

### Two live regions, not one

Politeness is fixed on the container, so errors go into an `aria-live="assertive"` list and
everything else into a `polite` one. A single region would force one politeness for both,
and either the screen-reader user is interrupted by "Copied" or they miss "Save failed".

**Warnings stay polite deliberately.** This app produces them constantly — weak password,
expiring soon — and interrupting per warning makes it unusable with a screen reader.

### Pausing is a requirement, not a nicety

Hover **and focus** both pause the countdown, and it resumes with the _remaining_ time
rather than the full duration. WCAG 2.2 requires time limits be pausable; the reason it
requires it is that an undo you cannot finish reading is an undo you cannot use.

### Toasts are cleared when the vault locks

`src/renderer/src/vault/ClearToastsOnLock.tsx`. A toast can name a record — "Moved GitHub
to Trash" — and a lock means the vault's contents are no longer on screen. A notification
outliving the lock leaves an account name sitting over the unlock screen, which is what
someone locks their vault to prevent, and strands an Undo whose action can no longer run.

Written as a **store subscription** rather than an effect watching a prop: subscribing to
an external source and dispatching from its callback is what effects are for, while
comparing state in an effect body and calling `setState` cascades a render on every session
change.

---

## 3. The modal is a native `<dialog>`

Keyhold ships one browser engine, so the usual cross-browser objection does not apply, and
the native element buys four things a hand-rolled modal has to fake:

- **The top layer** — no z-index war with anything, ever.
- **Genuine inertness** for assistive technology. A JavaScript focus trap only intercepts
  Tab; it does not stop a screen reader's virtual cursor reading the page behind.
- **`::backdrop`**, which cannot be scrolled past.
- **Escape**, for free.

Two deliberate overrides. `open` is controlled, so the native `cancel` event is
`preventDefault`ed and routed through `requestClose()`, which is idempotent per open cycle —
Escape reaches the handler twice in Chromium. And jsdom has no `showModal`, so there is a
documented attribute fallback that is reachable only in tests and provides **no** inertness;
it exists so the tests can run, not so the modal can degrade.

Focus returns to whatever opened the dialog. Removing that restoration drops focus to
`<body>`, which is a keyboard user losing their place entirely — and the test that catches
it fails with exactly that: `expected <body><button></button></body> to be <button>`.

`ConfirmDialog` distinguishes a destructive action **in words as well as colour**, and
carries a `consequence` line for the cases where "this cannot be undone" is the whole point.

---

## 4. Tooltips open on focus with no delay

500 ms on hover, **0 on focus**, a 140 ms close grace, and a 400 ms shared warm window so
moving along a toolbar does not re-wait.

Zero on focus for two reasons: a keyboard user has already committed to the control by
moving to it, and the `aria-describedby` relationship has to resolve at the moment a screen
reader reads the control, not half a second later.

Escape dismisses. The tooltip is itself hoverable, and it never closes on a timer — WCAG
2.2 SC 1.4.13 requires exactly that, because a tooltip that vanishes while you are reading
it is unusable at any reading speed slower than the author's.

---

## 5. Progress is honest about long waits

Unlocking is slow **by design** — Argon2 with calibrated cost is seconds of deliberate work
— so the bar exists to say "this is working" rather than to fill quickly. A `slowNote`
appears past a threshold, so a long unlock reads as expensive rather than hung.

Under `prefers-reduced-motion` the indeterminate bar becomes a **steady fill**, not a slower
sweep. A frozen animation would look exactly like the hang the component exists to disprove.

---

## 6. Empty states have copy, not just a shape

`components/Feedback.tsx` already had the shape — icon, heading, explanation, one action.
What was missing was the writing, so `empty-state-presets.ts` holds it and `AppEmptyState`
renders through the existing primitive. No second `EmptyState` component.

---

## 7. Not built

- **The global shortcut table and the command palette** (Ctrl/Cmd+K) — the first item of
  Phase 15, and a prerequisite for an F6 "jump to notifications" hotkey. Undo toasts are
  reachable by Tab today, being last in the document.
- **The image lightbox** — Phase 15, and it wants attachments (Phase 9) to be worth having.
- **Stacking and exit animation, and swipe-to-dismiss** — motion the reduced-motion switch
  would have to remove anyway, for no information gain.

---

## 8. Tests

62 tests, and **six fault injections all caught**:

| Injection                                 | What failed                                                     |
| ----------------------------------------- | --------------------------------------------------------------- |
| Visible cap removed                       | 5 tests, incl. `expected […] to have a length of 3 but got 20`  |
| Resume restarts the full duration         | 2 tests, off by exactly the elapsed time                        |
| Provider effect returns no `clearTimeout` | `leaves no timer running after unmount` — `expected 1 to be +0` |
| Modal Escape handler disabled             | `expected "vi.fn()" to be called 1 times, but got 0 times`      |
| Focus restoration removed                 | focus fell to `<body>`                                          |
| Viewport pauses on hover but not focus    | `stops the countdown while focus is inside the stack`           |

`@testing-library/react` is deliberately **not** a dependency. Component behaviour is tested
through `react-dom/client` and `act` (`test-dom.ts`), which covers Escape, focus
restoration, unmount cleanup, both pause paths, the cap and live-region routing.

Genuinely untested, and worth knowing: `Tooltip` and `ProgressBar` _rendering_ (their timing
and arithmetic are covered), `ConfirmDialog`'s markup (its focus-selector mechanism is
covered via `Modal`), and the native `showModal` trap and inertness — jsdom has no top
layer, so that is platform behaviour taken on trust.
