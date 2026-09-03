# Threat model

> **This page is published, in-app and in the README, deliberately.** A password manager that
> overstates its guarantees is worse than one that is candid about its limits, because users
> calibrate their behaviour to what they believe is true.
>
> Status: current reference. Update whenever the security architecture changes.

---

## 1. What Keyhold protects

| Threat                                                                                                    | How                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Someone steals the vault file** — from a USB stick, a cloud folder, a backup drive, an email attachment | The file is authenticated ciphertext. The key comes from Argon2id over the master password. Without that password there is nothing to read.                                                                                                                                 |
| **Someone steals the whole device while Keyhold is locked**                                               | Keys are zeroed on lock. The wrapped DEK held in the OS keychain for biometric unlock is itself bound to the OS user account (DPAPI / Keychain).                                                                                                                            |
| **A cloud or sync provider reads the vault**                                                              | They hold ciphertext. Dropbox, iCloud, OneDrive, Google Drive and Syncthing are all treated as untrusted transport.                                                                                                                                                         |
| **Someone tampers with the vault file**                                                                   | AES-256-GCM authenticates every chunk, and the plaintext header is passed as AAD. A single flipped bit anywhere causes a hard, loud failure — never a silent partial read.                                                                                                  |
| **Another local user account reads the vault**                                                            | Vault files are written with restrictive permissions. The biometric-unlock key is bound to the enrolling OS user.                                                                                                                                                           |
| **Shoulder-surfing**                                                                                      | Fields are masked by default; auto-lock on idle, sleep and OS screen lock; optional lock on minimise.                                                                                                                                                                       |
| **Clipboard scraping**                                                                                    | Auto-clear after a configurable interval; excluded from Windows clipboard history and cloud clipboard; excluded from the macOS persistent pasteboard via `org.nspasteboard.ConcealedType`; cleared on lock and on exit.                                                     |
| **A compromised renderer** — XSS, or a malicious npm dependency in the UI layer                           | The renderer holds only the **safe projection** and never the master key or any secret material. There is nothing there to exfiltrate. See decision D13.                                                                                                                    |
| **The vendor turns hostile, raises prices, or shuts down**                                                | There is no vendor. GPL-3.0, no server, a published format spec, and four export formats today — encrypted parcel, Keyhold JSON, Keyhold CSV and a Bitwarden-compatible CSV. KDBX 4 export is planned for Phase 11 and is **not** built; `kdbxweb` is not yet a dependency. |
| **Silent data loss**                                                                                      | Atomic writes, rolling backups, tombstones, mandatory pre-merge backups, trash with restore, undo on destructive actions, dry-run imports.                                                                                                                                  |

---

## 2. What Keyhold does **not** protect against

Stated plainly, because pretending otherwise would be dishonest.

| Threat                                                      | Why not                                                                                                                                         | What actually helps                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A compromised operating system**                          | If the OS is owned, every user-space defence is theatre. The attacker can read process memory, inject code, and see everything you see.         | Keep the OS patched. Do not run untrusted binaries. Full-disk encryption.                                                                            |
| **A keylogger**                                             | Your master password is typed on the same keyboard. No password manager can defend against this.                                                | An OS-level defence, not an app-level one. Biometric quick-unlock reduces how often the password is typed.                                           |
| **Malware reading Keyhold's memory while unlocked**         | While the vault is open, the DEK and decrypted records are in RAM by necessity.                                                                 | Short auto-lock intervals. Lock when stepping away. Node offers no reliable `mlock`; see backlog D5.                                                 |
| **A screen recorder while a secret is revealed**            | Revealed means visible.                                                                                                                         | Reveal only when needed; use copy rather than reveal; enable screen-capture blocking when built (backlog D4).                                        |
| **Anyone who knows your master password**                   | It is the key. There is no second gate by default.                                                                                              | Use a long unique passphrase. Enable a key file (backlog A3) or a hardware key (backlog D1) when built.                                              |
| **Physical access while the vault is open**                 | An unlocked vault is an open vault.                                                                                                             | Aggressive auto-lock; lock on minimise; lock on OS screen lock.                                                                                      |
| **A forgotten master password**                             | There is no backdoor, by design. No recovery, no reset, no support email that can help.                                                         | Write it down and store it physically somewhere safe. Or enable the recovery kit when built (backlog A4) and understand its trade-off.               |
| **A malicious dependency in a build you compiled yourself** | Supply-chain risk is real for every JavaScript project.                                                                                         | Use official releases with published checksums. Dependabot and `npm audit` in CI. Reproducible builds (backlog D6) would make verification possible. |
| **Traffic analysis of the opt-in HIBP check**               | If enabled, a network observer learns that you checked _something_, and sees a 5-character hash prefix matching roughly 400–800 real passwords. | It is off by default. Leave it off, or run it once over a VPN. Never sends the password or the full hash.                                            |
| **Someone with your `.keepx` bundle and its passphrase**    | That is what a bundle is for.                                                                                                                   | Use a strong, different passphrase; deliver it out of band.                                                                                          |

---

## 3. Assets, ranked

What an attacker actually wants, worst first.

1. **The master password.** Compromise here is total. Never stored, never logged, never transmitted, never written to disk in any form.
2. **The DEK while unlocked.** Held in main-process memory only; zeroed on lock; never crosses IPC.
3. **The vault file.** Assumed to be obtainable. All security rests on the ciphertext being sound.
4. **The wrapped DEK in the OS keychain** (biometric unlock). Bound to the OS user; independently revocable without touching the password path.
5. **Individual revealed secrets.** Minimised by the safe-projection design and clipboard TTLs.
6. **Record metadata** — titles, usernames, URLs, tags. Encrypted in the file, but present in renderer memory while unlocked. A compromised renderer learns _which accounts you have_, but not the passwords. This is a real, accepted residual risk, recorded here rather than hidden.
7. **Origin metadata** — device names, network names. Encrypted, and capped by the user's privacy level. Set the level to `none` if even encrypted provenance is unwanted.

---

## 4. Trust boundaries

```
  UNTRUSTED  ─────────────────────────────────────────────────────────
   The filesystem · cloud sync providers · USB media · the network
   Everything crossing this line is ciphertext, or it does not cross.
  ────────────────────────────────────────────────────────────────────
  SEMI-TRUSTED  ──────────────────────────────────────────────────────
   The renderer process — React, npm dependencies, the DOM
   Holds the safe projection. Never the keys. Never secret material.
  ────────────────────────────────────────────────────────────────────
  TRUSTED  ───────────────────────────────────────────────────────────
   The main process — crypto, file I/O, keys, decrypted records
   The smallest surface we can make it, and the most reviewed code.
  ────────────────────────────────────────────────────────────────────
  ASSUMED TRUSTED (outside our control)
   The operating system · the CPU · the user's own discipline
```

---

## 5. Cryptographic choices and why they are boring on purpose

Novel cryptography is how password managers get broken. Every primitive here is standard,
well-analysed, and widely deployed.

| Choice                                   | Rationale                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Argon2id** for key derivation          | The current password-hashing standard. Memory-hard, so GPU and ASIC attacks scale badly. Parameters are calibrated per machine and stored in the header so a vault carries its own settings. |
| **AES-256-GCM** for encryption           | Authenticated encryption (AEAD). Encryption and integrity in one primitive, hardware-accelerated on every modern CPU. Tampering is detected, not silently accepted.                          |
| **Envelope encryption** (KEK wraps DEK)  | Changing the master password rewraps 32 bytes rather than re-encrypting the vault. Each additional unlock method is another independent wrapping, revocable on its own.                      |
| **A random 96-bit nonce per encryption** | GCM's requirement. Nonce reuse under one key is catastrophic, so nonces are always freshly generated, never derived and never counted.                                                       |
| **The header as AAD**                    | The header must be readable to know how to decrypt, but must not be modifiable. Authenticating it without encrypting it is exactly what AAD is for.                                          |
| **gzip before encryption**               | Compression after encryption is pointless. Before is standard, and the vault contains no attacker-chosen plaintext mixed with secrets, so CRIME-style oracle attacks do not apply here.      |
| **`crypto.randomBytes` only**            | A CSPRNG for every salt, nonce, DEK and generated password. `Math.random()` never touches anything security-relevant.                                                                        |

---

## 6. Reporting a vulnerability

See [`SECURITY.md`](../../SECURITY.md) in the repository root. Report privately first; a
coordinated disclosure window is offered. There is no bug bounty — the project has no funding — but
credit is given in the changelog and the security page.
