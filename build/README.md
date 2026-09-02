<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# `build/` — packaging resources

This is electron-builder's `buildResources` directory (set in
[`electron-builder.yml`](../electron-builder.yml)). electron-builder discovers files here
**by filename**, so nothing in this folder is referenced from the config — it is found or
it is not. Its contents are never copied into the packaged app.

> **This directory is currently excluded by `.gitignore`.** The line `build/` under
> "Build output" was written for a build-output folder that this project does not have
> (electron-vite writes to `out/`, electron-builder writes to `release/`). Until that line
> is removed, none of these files reach a CI checkout and every CI build is unbranded.
> The exact fix is in
> [`docs/13-Packaging/00-Building-And-Releasing.md`](../docs/13-Packaging/00-Building-And-Releasing.md).

---

## What is here

| File                     | Status                | Purpose                                                                    |
| ------------------------ | --------------------- | -------------------------------------------------------------------------- |
| `entitlements.mac.plist` | Present, **inert**    | macOS hardened-runtime entitlements, for the day a signing certificate exists |
| `icon.ico`               | **Missing**           | Windows application and installer icon                                     |
| `icon.icns`              | **Missing**           | macOS application icon                                                     |
| `icon.png`               | **Missing**           | Source icon; electron-builder can derive the others from it                |
| `installerHeader.bmp`    | Missing, optional     | NSIS wizard header strip                                                   |
| `installerSidebar.bmp`   | Missing, optional     | NSIS welcome/finish page sidebar                                           |
| `background.png`         | Missing, optional     | DMG window background                                                      |
| `license_en.txt`         | Missing, optional     | Plain-text licence page in the NSIS wizard                                 |

A build with no icons **succeeds**. It ships the stock Electron icon, which looks like an
unfinished app — fine for a development build, not for a release.

---

## Icon specifications

Produce one square master and derive the rest. The artwork itself is a manual task; see
`MANUAL-BACKLOG.md`.

**`icon.png` — the master.** 1024×1024, PNG, RGBA, no padding baked in beyond what the
design wants. If only this file is present, electron-builder generates the platform icons
itself; hand-built `.ico` and `.icns` files give better control of the small sizes, where
a detailed mark turns to mush.

**`icon.ico` — Windows.** A multi-resolution ICO containing 16, 24, 32, 48, 64, 128 and
256 px layers. 256 is the minimum electron-builder accepts. The 16 px layer is the one
users actually see most (taskbar, title bar, Explorer list view) and almost always needs
to be drawn separately rather than downscaled.

**`icon.icns` — macOS.** An ICNS containing 16, 32, 64, 128, 256, 512 and 1024 px, each
in 1× and 2×. macOS also expects the mark to sit inside the standard rounded-square
"squircle" with the platform's margins — an edge-to-edge icon reads as wrong on the Dock
next to everything else.

**Installer artwork (optional).** `installerHeader.bmp` is 150×57; `installerSidebar.bmp`
is 164×314. Both must be BMP — NSIS will not take a PNG.

---

## Adding a per-file-type icon

`.keep`, `.keepx` and `.keeptheme` are registered as file types in `electron-builder.yml`
but have no distinct document icons, so the OS shows the application icon for all three.
To give them their own, add `icon.ico`/`icon.icns` pairs here and point each association
at them:

```yaml
fileAssociations:
  - ext: keep
    icon: build/keep # extension omitted; electron-builder picks .ico or .icns per platform
```

Worth doing eventually: a vault, a parcel and a theme looking identical in a file manager
is the sort of thing that leads someone to send the wrong file to somebody else.
