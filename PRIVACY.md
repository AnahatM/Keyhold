# Privacy

**Keyhold collects nothing. There is nothing to collect it with.**

This is not a promise about how data is handled — it is a description of what the software
does. There is no server, no account, no analytics, no crash reporter, and no update ping.

## What leaves your device

By default: **nothing at all.** Keyhold makes no network requests. The renderer's
Content-Security-Policy sets `connect-src 'none'`, so it cannot originate one even if a
dependency tried.

There is exactly one optional exception. It is **off by default**, it needs **two** separate
switches turned on, and it never runs on its own.

### The breach check — opt-in, off by default, and never automatic

If — and only if — you turn it on, Keyhold sends the **first five characters of the SHA-1
hash** of a password to the Pwned Passwords API. This is the standard
[k-anonymity](https://haveibeenpwned.com/API/v3#PwnedPasswords) model:

- Your password never leaves the device.
- The full hash never leaves the device.
- The five-character prefix matches several hundred thousand unrelated hashes, so the
  service cannot tell which password you asked about, or whether it was found.
- The comparison happens locally, against the list of suffixes the API returns.

What the service — and anything watching the connection — can see is that a request came
from your network address. Never which password, and never the answer.

**Two switches, not one.** A machine-wide "let Keyhold make network requests" switch is off
by default and is stored on this computer; the breach check itself is a separate opt-in
stored **inside the vault file**, so a copy of your vault on another machine is not checked
there unless you turn it on there too. The machine switch dominates: while it is off, no
connection can be opened at all — not disabled, but absent, because the code that would open
one is never constructed. Turning either on shows you a dialog saying exactly what it means
first.

**It never runs by itself.** There is no check on unlock, no check on a timer, and no check
because you opened a screen. A request happens when you press a button on the vault health
screen and at no other time. That screen also tells you how many requests the check made.

## What is stored, and where

Everything lives in the vault file you chose the location of. It is encrypted with a key
derived from your master password (Argon2id) and never leaves your control.

Some metadata is recorded **inside** the encrypted vault to power the edit-history feature:
the device name, the app version, the platform, and optionally the network name and OS
user. This is encrypted along with everything else, and you choose how much of it is
captured — `none`, `device`, `network`, or `full`. The control is in Settings under History
& audit. The default is `device`: the device name, the platform and the app version, and
never the OS user, the network name or an IP address.

Application preferences (theme, window size, recent vault paths) are stored unencrypted in
the standard per-user application data directory for your OS. They contain no secrets.

## What Keyhold cannot protect

Honest limits are documented in [the threat model](./docs/00-Overview/03-Threat-Model.md).
Read it. A password manager that overstates its guarantees is worse than one that is candid.

## Third parties

There are none. Keyhold has no analytics provider, no error-tracking service, no CDN, and
no advertising. The only external endpoint the software knows about is the Pwned Passwords
API, and only when you switch it on.
