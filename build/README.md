<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# `build/` — packaging resources

This is electron-builder's `buildResources` directory (set in
[`electron-builder.yml`](../electron-builder.yml)). electron-builder discovers files here
**by filename**, so nothing in this folder is referenced from the config — it is found or
it is not. Its contents are never copied into the packaged app.

> **This directory is committed**, and the `.gitignore` says so out loud: the `build/` line
> under "Build output" is gone, replaced by a comment explaining that this folder holds
> electron-builder's _inputs_ rather than its output. Ignoring it meant no CI checkout ever
> had an icon, and every automated build was unbranded.

---

## What is here

| File                     | Status             | Purpose                                                                       |
| ------------------------ | ------------------ | ----------------------------------------------------------------------------- |
| `entitlements.mac.plist` | Present, **inert** | macOS hardened-runtime entitlements, for the day a signing certificate exists |
| `icon.svg`               | **Generated**      | The mark as vectors, for the README and the docs                              |
| `icon.png`               | **Generated**      | 1024 master; electron-builder's Linux source and its fallback                 |
| `icon.ico`               | **Generated**      | Windows application and installer icon, seven sizes                           |
| `icon.icns`              | **Generated**      | macOS application icon, ten OSTypes including every retina variant            |
| `icons/*.png`            | **Generated**      | 16 – 1024 standalone, for Linux packaging and for documents                   |
| `installerHeader.bmp`    | Missing, optional  | NSIS wizard header strip                                                      |
| `installerSidebar.bmp`   | Missing, optional  | NSIS welcome/finish page sidebar                                              |
| `background.png`         | Missing, optional  | DMG window background                                                         |
| `license_en.txt`         | Missing, optional  | Plain-text licence page in the NSIS wizard                                    |

A build with no icons **succeeds**. It ships the stock Electron icon, which looks like an
unfinished app — fine for a development build, not for a release.

---

## The icons are generated — do not edit them

Everything in the "Generated" rows above comes from
[`tools/make-icons.mjs`](../tools/make-icons.mjs). Run `npm run icons` after changing it.

**Editing one of these files by hand will fail the build.** `tools/icons.test.ts`
regenerates the whole set and compares bytes, because an icon retouched in a paint program
and committed without its source is an asset nobody can reproduce — and the next change to
the brand colour would silently leave it behind. The same test parses the `.ico` and `.icns`
back, since a wrong offset in either produces a file every tool accepts and the OS declines
to draw, and nothing else in this repo ever opens one.

**To change the mark**, edit the geometry constants at the top of the script — they are
fractions of the canvas, so one definition serves 16 pixels and 1024 alike — and run
`npm run icons`. The SVG, the PNGs and both containers all follow from them.

---

## Icon specifications

What the platforms want, and what the generator therefore produces.

**`icon.png` — the master.** 1024×1024, PNG, RGBA. If only this file were present,
electron-builder would generate the platform icons itself; the hand-built `.ico` and `.icns`
give better control of the small sizes, where a detailed mark turns to mush — which is why
the generator writes all three rather than leaving the downscaling to the packager.

**`icon.ico` — Windows.** A multi-resolution ICO containing 16, 24, 32, 48, 64, 128 and
256 px layers. 256 is the minimum electron-builder accepts. The 16 px layer is the one
users actually see most (taskbar, title bar, Explorer list view) and almost always needs
to be drawn separately rather than downscaled.

**`icon.icns` — macOS.** An ICNS containing 16, 32, 64, 128, 256, 512 and 1024 px, each
in 1× and 2×: `icp4`, `icp5`, `ic07`–`ic10` for the 1× set and `ic11`–`ic14` for retina.
Omitting the 2× entries gives a blurry icon on every Mac made in the last decade, and
nothing warns about it. macOS also expects the mark to sit inside the standard
rounded-square "squircle" — the generator draws the plate at a 22.37% corner radius, which
is Apple's continuous-corner figure and near enough for a shape this simple.

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
