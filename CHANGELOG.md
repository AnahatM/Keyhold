# Changelog

All notable changes to Keyhold are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The in-app Changelog view (Phase 16) renders this file directly — there is deliberately
no second, hand-maintained copy.

## [Unreleased]

### Added

- Project scaffold: Electron + electron-vite + React 19 + TypeScript strict, with path
  aliases kept in sync across the build config and both tsconfigs by a guard test.
- Hardened renderer by default: `contextIsolation`, `sandbox`, no Node integration in any
  frame or worker, `<webview>` disabled, all web permissions denied, and a strict CSP with
  no `unsafe-eval`, no `unsafe-inline` in `script-src`, and `connect-src 'none'`.
- Navigation lockdown: external links open in the real browser, popups and new windows are
  denied, and devtools are closed on sight in packaged builds.
- Single-instance lock, so two processes can never race writes to the same vault file.
- SPDX licence-header lint rule, written locally, with its own fault-injected test.
- Launch smoke test that starts the real app and verifies the preload bridge is present.

### Notes

- Nothing is stored yet. The vault format and cryptography arrive in Phase 1; see
  [the roadmap](./docs/12-Roadmap/00-Master-Checklist.md).
