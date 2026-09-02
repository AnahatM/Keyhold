# Privacy

**Keyhold collects nothing. There is nothing to collect it with.**

This is not a promise about how data is handled — it is a description of what the software
does. There is no server, no account, no analytics, no crash reporter, and no update ping.

## What leaves your device

By default: **nothing at all.** Keyhold makes no network requests. The renderer's
Content-Security-Policy sets `connect-src 'none'`, so it cannot originate one even if a
dependency tried.

There is exactly one optional exception:

### The breach check (opt-in, off by default)

If — and only if — you turn on the Have I Been Pwned check in Settings, Keyhold sends the
**first five characters of the SHA-1 hash** of a password to the Pwned Passwords API. This
is the standard [k-anonymity](https://haveibeenpwned.com/API/v3#PwnedPasswords) model:

- Your password never leaves the device.
- The full hash never leaves the device.
- The five-character prefix matches several hundred unrelated passwords, so the service
  cannot tell which one you asked about.
- The comparison happens locally, against the list of suffixes the API returns.

You are shown exactly this before it can be enabled, and a global network kill-switch in
Settings disables it outright.

## What is stored, and where

Everything lives in the vault file you chose the location of. It is encrypted with a key
derived from your master password (Argon2id) and never leaves your control.

Some metadata is recorded **inside** the encrypted vault to power the edit-history feature:
the device name, the app version, the platform, and optionally the network name and OS
user. This is encrypted along with everything else, and you choose how much of it is
captured — `none`, `device`, `network`, or `full` — in Settings → Privacy.

Application preferences (theme, window size, recent vault paths) are stored unencrypted in
the standard per-user application data directory for your OS. They contain no secrets.

## What Keyhold cannot protect

Honest limits are documented in [the threat model](./docs/00-Overview/03-Threat-Model.md).
Read it. A password manager that overstates its guarantees is worse than one that is candid.

## Third parties

There are none. Keyhold has no analytics provider, no error-tracking service, no CDN, and
no advertising. The only external endpoint the software knows about is the Pwned Passwords
API, and only when you switch it on.
