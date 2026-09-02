// SPDX-License-Identifier: GPL-3.0-or-later

import type { Toast, ToastEvent, ToastInput, ToastPauseReason, ToastState } from './toast-types.js';

/**
 * The toast queue: pure policy and arithmetic, no React.
 *
 * Everything that can go wrong with toasts goes wrong here rather than in the markup —
 * a flood that stacks off screen, an undo that vanishes before it is read, a timer that
 * outlives its component. So this file is the one that gets tested, and the provider that
 * drives it stays thin enough to read in one sitting.
 *
 * ## The queue policy
 *
 * Three rules, in order. They exist because "twenty toasts in one second" is not a
 * hypothetical: holding a copy shortcut, a bulk import reporting per-row failures, or a
 * merge touching hundreds of records all produce exactly that.
 *
 * 1. **Coalesce.** A toast whose `dedupeKey` matches a live one replaces it in place and
 *    bumps `repeatCount` ("Copied ×7"). The clock restarts, because the user just acted.
 *    This is the rule that actually absorbs a flood; the two below are the backstop.
 *
 * 2. **Cap what is visible** at {@link MAX_VISIBLE_TOASTS}. Anything further waits in a
 *    queue and is promoted as slots free up. Three toasts is already more than anyone
 *    reads at a glance; a stack tall enough to run off the screen edge is strictly worse
 *    than a queue, because the ones off screen can never be dismissed.
 *
 * 3. **Bound the queue** at {@link MAX_QUEUED_TOASTS}, evicting the oldest expiring entry.
 *    Unbounded is not an option — a runaway loop would grow it until the process died.
 *
 * ## Why an undo does not auto-dismiss
 *
 * A toast carrying an action defaults to `durationMs: null` — it stays until the user
 * dismisses it or takes the action. An undo that expires before it is read is not an undo;
 * it is a delay before data loss. The same goes for an error: "Save failed" sliding away
 * after six seconds is how a user comes to believe a save succeeded.
 *
 * That makes `durationMs === null` — *persistent* — the useful category, and it drives
 * eviction: a persistent toast is never evicted to make room for one that would have
 * expired on its own. Rules 2 and 3 retire the oldest **expiring** toast first, and only
 * fall back to a persistent one when there is nothing else left. Reaching that fallback
 * needs {@link MAX_VISIBLE_TOASTS} + {@link MAX_QUEUED_TOASTS} unresolved undos and
 * errors at once, which no sequence of deliberate user gestures produces.
 */

/** On screen at once. Beyond this, toasts queue. */
export const MAX_VISIBLE_TOASTS = 3;

/** Waiting for a slot. Beyond this, the oldest expiring entry is dropped. */
export const MAX_QUEUED_TOASTS = 8;

export const SUCCESS_TOAST_MS = 5_000;
export const INFO_TOAST_MS = 5_000;
export const WARNING_TOAST_MS = 8_000;

/**
 * Sub-frame slack when deciding whether a deadline has passed.
 *
 * `setTimeout` is allowed to fire a hair early, and a reap that sweeps nothing leaves the
 * provider's effect keyed on an unchanged deadline — the timer would never be rescheduled
 * and the toast would sit there for ever. Four milliseconds is under a frame at 240Hz, so
 * it cannot shorten a toast perceptibly, and it removes the stall entirely.
 */
export const EXPIRY_TOLERANCE_MS = 4;

/**
 * How long a toast stays, when the caller does not say.
 *
 * An action or an error means "until dismissed" — see the file header for why.
 */
export function defaultDurationMs(input: ToastInput): number | null {
  if (input.action !== undefined) return null;
  switch (input.tone ?? 'info') {
    case 'error':
      return null;
    case 'warning':
      return WARNING_TOAST_MS;
    case 'success':
      return SUCCESS_TOAST_MS;
    case 'info':
      return INFO_TOAST_MS;
  }
}

/**
 * Toast ids are a monotonic counter, not randomness.
 *
 * They are React keys and `aria-labelledby` targets, never anything security-relevant, so
 * a CSPRNG would be a misleading signal about what this value is for. A counter is also
 * deterministic, which is what makes the reducer testable without stubbing a clock twice.
 */
export function nextToastId(counter: number): string {
  return `kh-toast-${counter}`;
}

/** Normalise a caller's input into the internal record. The clock starts on push, not here. */
export function createToast(input: ToastInput, id: string): Toast {
  return {
    id,
    tone: input.tone ?? 'info',
    title: input.title,
    description: input.description ?? null,
    dedupeKey: input.dedupeKey ?? null,
    action: input.action ?? null,
    durationMs: input.durationMs !== undefined ? input.durationMs : defaultDurationMs(input),
    repeatCount: 1,
    expiresAt: null,
    remainingMs: null,
  };
}

export function createInitialToastState(): ToastState {
  return { visible: [], queued: [], pauseReasons: [] };
}

/** A toast that stays until it is dealt with: an undo, or a failure. */
function isPersistent(toast: Toast): boolean {
  return toast.durationMs === null;
}

/** Start (or restart) a toast's countdown, honouring a stack that is currently paused. */
function startClock(toast: Toast, now: number, paused: boolean): Toast {
  if (toast.durationMs === null) return { ...toast, expiresAt: null, remainingMs: null };
  if (paused) return { ...toast, expiresAt: null, remainingMs: toast.durationMs };
  return { ...toast, expiresAt: now + toast.durationMs, remainingMs: null };
}

/**
 * Index of the entry to sacrifice: the oldest expiring one, or the oldest of any kind if
 * every entry is persistent. `-1` when the list is empty.
 */
function evictionIndex(toasts: readonly Toast[]): number {
  const expiring = toasts.findIndex((toast) => !isPersistent(toast));
  if (expiring !== -1) return expiring;
  return toasts.length > 0 ? 0 : -1;
}

function removeAt(toasts: readonly Toast[], index: number): readonly Toast[] {
  return toasts.filter((_, position) => position !== index);
}

/**
 * Fill empty visible slots from the head of the queue.
 *
 * Promotion starts the promoted toast's clock now rather than when it was pushed —
 * otherwise a toast that waited eight seconds behind three others would appear and vanish
 * in the same frame, having spent its whole life invisible.
 */
function promote(state: ToastState, now: number): ToastState {
  if (state.queued.length === 0 || state.visible.length >= MAX_VISIBLE_TOASTS) return state;

  const paused = state.pauseReasons.length > 0;
  const slots = MAX_VISIBLE_TOASTS - state.visible.length;
  const moving = state.queued.slice(0, slots);

  return {
    ...state,
    visible: [...state.visible, ...moving.map((toast) => startClock(toast, now, paused))],
    queued: state.queued.slice(moving.length),
  };
}

/** Rule 1: fold a repeat into the toast already carrying its key. */
function coalesce(state: ToastState, incoming: Toast, now: number): ToastState | null {
  if (incoming.dedupeKey === null) return null;
  const paused = state.pauseReasons.length > 0;

  const visibleIndex = state.visible.findIndex((toast) => toast.dedupeKey === incoming.dedupeKey);
  if (visibleIndex !== -1) {
    const existing = state.visible[visibleIndex];
    // `existing` cannot be undefined — findIndex returned a real index. The check is here
    // only because noUncheckedIndexedAccess cannot know that.
    if (existing === undefined) return null;
    const merged = startClock(
      // The new id is adopted deliberately. Keeping the old one would leave the live region
      // silent about the repeat, because a screen reader announces an added node far more
      // reliably than a changed text node. Keeping the *position* is what stops the stack
      // from reshuffling under the pointer.
      { ...incoming, repeatCount: existing.repeatCount + 1 },
      now,
      paused
    );
    return {
      ...state,
      visible: state.visible.map((toast, index) => (index === visibleIndex ? merged : toast)),
    };
  }

  const queuedIndex = state.queued.findIndex((toast) => toast.dedupeKey === incoming.dedupeKey);
  if (queuedIndex !== -1) {
    const existing = state.queued[queuedIndex];
    if (existing === undefined) return null;
    const merged: Toast = { ...incoming, repeatCount: existing.repeatCount + 1 };
    return {
      ...state,
      queued: state.queued.map((toast, index) => (index === queuedIndex ? merged : toast)),
    };
  }

  return null;
}

function push(state: ToastState, incoming: Toast, now: number): ToastState {
  const coalesced = coalesce(state, incoming, now);
  if (coalesced !== null) return coalesced;

  const paused = state.pauseReasons.length > 0;

  // Rule 2: a free slot is the easy case.
  if (state.visible.length < MAX_VISIBLE_TOASTS) {
    return { ...state, visible: [...state.visible, startClock(incoming, now, paused)] };
  }

  // A persistent toast — an undo or a failure — does not wait behind an ordinary one that
  // is going to disappear by itself anyway. It takes that toast's slot immediately, because
  // an undo the user cannot see is an undo they do not have.
  if (isPersistent(incoming)) {
    const sacrificeIndex = state.visible.findIndex((toast) => !isPersistent(toast));
    if (sacrificeIndex !== -1) {
      return {
        ...state,
        visible: [...removeAt(state.visible, sacrificeIndex), startClock(incoming, now, paused)],
      };
    }
  }

  // Rule 3: queue it, and keep the queue bounded.
  let queued: readonly Toast[] = [...state.queued, incoming];
  while (queued.length > MAX_QUEUED_TOASTS) {
    const index = evictionIndex(queued);
    if (index === -1) break;
    queued = removeAt(queued, index);
  }
  return { ...state, queued };
}

function reap(state: ToastState, now: number): ToastState {
  const survivors = state.visible.filter(
    (toast) => toast.expiresAt === null || toast.expiresAt > now + EXPIRY_TOLERANCE_MS
  );
  if (survivors.length === state.visible.length) return promote(state, now);
  return promote({ ...state, visible: survivors }, now);
}

function pause(state: ToastState, reason: ToastPauseReason, now: number): ToastState {
  if (state.pauseReasons.includes(reason)) return state;
  const pauseReasons = [...state.pauseReasons, reason];
  if (state.pauseReasons.length > 0) return { ...state, pauseReasons };

  return {
    ...state,
    pauseReasons,
    visible: state.visible.map((toast) =>
      toast.expiresAt === null
        ? toast
        : { ...toast, expiresAt: null, remainingMs: Math.max(0, toast.expiresAt - now) }
    ),
  };
}

function resume(state: ToastState, reason: ToastPauseReason, now: number): ToastState {
  if (!state.pauseReasons.includes(reason)) return state;
  const pauseReasons = state.pauseReasons.filter((held) => held !== reason);
  // Still held by another reason — the pointer left but focus is still inside, say.
  if (pauseReasons.length > 0) return { ...state, pauseReasons };

  return {
    ...state,
    pauseReasons,
    visible: state.visible.map((toast) =>
      toast.remainingMs === null
        ? toast
        : { ...toast, expiresAt: now + toast.remainingMs, remainingMs: null }
    ),
  };
}

export function toastReducer(state: ToastState, event: ToastEvent): ToastState {
  switch (event.type) {
    case 'push':
      return push(state, event.toast, event.now);
    case 'dismiss': {
      const visible = state.visible.filter((toast) => toast.id !== event.id);
      const queued = state.queued.filter((toast) => toast.id !== event.id);
      if (visible.length === state.visible.length && queued.length === state.queued.length) {
        return state;
      }
      return promote({ ...state, visible, queued }, event.now);
    }
    case 'reap':
      return reap(state, event.now);
    case 'pause':
      return pause(state, event.reason, event.now);
    case 'resume':
      return resume(state, event.reason, event.now);
    case 'clear':
      return createInitialToastState();
  }
}

/**
 * The next moment anything expires, or `null` if nothing does.
 *
 * This is the whole scheduling story: the provider keys one `setTimeout` on this number.
 * One timer for the entire stack, rescheduled only when the earliest deadline actually
 * moves — no interval, no per-toast timer, nothing to leak on unmount.
 */
export function earliestExpiry(state: ToastState): number | null {
  let earliest: number | null = null;
  for (const toast of state.visible) {
    if (toast.expiresAt === null) continue;
    if (earliest === null || toast.expiresAt < earliest) earliest = toast.expiresAt;
  }
  return earliest;
}
