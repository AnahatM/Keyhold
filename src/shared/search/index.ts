// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Search, filter and sort over the safe projection.
 *
 * Pure TypeScript over `CredentialProjection` — no clock, no I/O, no platform. It lives in
 * `@shared` because both halves need it: the renderer to filter the list it already holds
 * without a round trip per keystroke, and the main process to answer the same question the
 * same way for exports, parcels and the deep-search fallback. Two implementations of "what
 * matches" would disagree within a month.
 *
 *   parseQuery(text)  →  ParsedQuery   what the user asked for
 *   searchCredentials →  SearchResult  who matches, how well, and where
 *   sortCredentials   →  a total, stable order
 *
 * Import from this barrel rather than the individual modules, so the public surface is one
 * reviewable list.
 */

export * from './query.js';
export * from './filter.js';
export * from './sort.js';
