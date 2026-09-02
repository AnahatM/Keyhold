// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The IPC contract — one source of truth for what the renderer can ask the main
 * process to do.
 *
 * Both sides import from here: the preload builds this shape, the renderer consumes
 * it, and the main process implements handlers against it. Keeping it in one file is
 * the "no second list" rule applied to the most dangerous list in the codebase.
 *
 * Two standing rules for anything added here:
 *
 *   1. **No method may return secret material as part of bulk data.** Passwords,
 *      note bodies, security-question answers, TOTP seeds and attachment bytes are
 *      fetched one at a time, on explicit user action, and expire. That is decision
 *      D13 and it is the difference between "a bug leaked a password" and "a bug
 *      leaked every password".
 *   2. **Every payload is validated at runtime on both sides.** TypeScript types are
 *      erased at runtime and prove nothing about what actually arrived over IPC.
 *
 * Channel naming: `kh:<domain>:<action>`.
 */

/**
 * Spelled out rather than aliased to `NodeJS.Platform`, because `@shared` is imported
 * by the renderer, which has no Node types by design. Shared code must type-check in
 * both environments.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd';

export interface AppApi {
  /** The running Keyhold version, baked in at build time. */
  getVersion: () => Promise<string>;
  /** The host platform, so the renderer can render the right modifier keys and menus. */
  getPlatform: () => Promise<Platform>;
}

/**
 * The complete surface exposed on `window.keyhold`.
 *
 * Grows one namespace per phase: `vault` (Phase 2), `credentials` (Phase 5),
 * `history` (Phase 6), `generator` (Phase 8), `importExport` (Phases 10–11),
 * `sync` (Phase 12), `health` (Phase 13), `settings` (Phase 14).
 */
export interface KeyholdApi {
  app: AppApi;
}

/** IPC channel names. Never build one by string concatenation at a call site. */
export const CHANNELS = {
  appGetVersion: 'kh:app:get-version',
  appGetPlatform: 'kh:app:get-platform',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
