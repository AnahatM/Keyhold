# Privacy

**Keyhold collects nothing. There is nothing to collect it with.**

This is not a promise about how data is handled — it is a description of what the software
does. There is no server, no account, no analytics, no crash reporter, and no update ping.

## What leaves your device

By default: **nothing at all.** Keyhold makes no network requests. The renderer's
Content-Security-Policy sets `connect-src 'none'`, so it cannot originate one even if a
dependency tried.

There is exactly one optional exception, and **it is not built yet.** What follows describes
how it will behave when it ships; today no part of it is reachable, no setting turns it on,
and the app makes no request of any kind. This section is written in advance because the
design is fixed and publishing it before the code exists is the honest order to do it in.

### The breach check (planned — opt-in, off by default)

If — and only if — you turn on the Have I Been Pwned check in Settings, Keyhold will send
the **first five characters of the SHA-1 hash** of a password to the Pwned Passwords API.
This is the standard [k-anonymity](https://haveibeenpwned.com/API/v3#PwnedPasswords) model:

- Your password never leaves the device.
- The full hash never leaves the device.
- The five-character prefix matches several hundred unrelated passwords, so the service
  cannot tell which one you asked about.
- The comparison happens locally, against the list of suffixes the API returns.

You will be shown exactly this before it can be enabled, and a global network kill-switch in
Settings will disable it outright. **Neither the consent screen nor the kill-switch exists
today** — there is nothing yet for either to govern. Until they do, the guarantee is
stronger than a setting: there is no code path in the running app that makes a request.

## What is stored, and where

Everything lives in the vault file you chose the location of. It is encrypted with a key
derived from your master password (Argon2id) and never leaves your control.

Some metadata is recorded **inside** the encrypted vault to power the edit-history feature:
the device name, the app version, the platform, and optionally the network name and OS
user. This is encrypted along with everything else, and you choose how much of it is
captured — `none`, `device`, `network`, or `full`. The control for it is built but is not
yet routed into the app's Settings screen, so today the level stays at its default,
`device`: the device name, the platform and the app version, and never the OS user, the
network name or an IP address.

Application preferences (theme, window size, recent vault paths) are stored unencrypted in
the standard per-user application data directory for your OS. They contain no secrets.

## What Keyhold cannot protect

Honest limits are documented in [the threat model](./docs/00-Overview/03-Threat-Model.md).
Read it. A password manager that overstates its guarantees is worse than one that is candid.

## Third parties

There are none. Keyhold has no analytics provider, no error-tracking service, no CDN, and
no advertising. The only external endpoint the software knows about is the Pwned Passwords
API, and only when you switch it on.
