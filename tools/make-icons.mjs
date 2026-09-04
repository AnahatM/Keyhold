// SPDX-License-Identifier: GPL-3.0-or-later
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Draws Keyhold's application icon, and writes every format the build needs.
 *
 * `node tools/make-icons.mjs` → `build/icon.svg`, `build/icon.png`, `build/icon.ico`,
 * `build/icon.icns`, and the small PNGs Linux packaging wants.
 *
 * ## Why this is a script and not a design file
 *
 * The alternative was an icon library or a hand-drawn asset, and both put the mark somewhere
 * this repo cannot check. Here it is **one set of numbers** — the geometry constants below —
 * and everything downstream is derived: the SVG the README uses, the raster the packager
 * embeds, and the Windows and macOS containers. Change the accent and every file changes with
 * it. There is no second copy to forget, which is rule 8 applied to artwork.
 *
 * It also means the icon is reproducible: the same input produces byte-identical output, and
 * `tools/icons.test.ts` regenerates it and compares, so an icon edited by hand and committed
 * without its source fails the build rather than drifting quietly.
 *
 * ## Why no dependency, and no SVG rasteriser
 *
 * Rasterising arbitrary SVG needs a library. Rasterising **this** shape needs a circle test, a
 * trapezoid test and a rounded-rectangle test, which are twelve lines of arithmetic — so the
 * shape is defined as maths, sampled 4×4 per pixel for anti-aliasing, and emitted as SVG from
 * the same constants. Nothing is installed, and the two representations cannot disagree
 * because neither is the source: the numbers are.
 *
 * PNG, ICO and ICNS are all written here too. PNG is a zlib stream and four CRC-tagged chunks;
 * ICO and ICNS are both containers that may hold PNGs directly. None of that warrants a
 * package in an app whose pitch is that it ships almost nothing.
 *
 * ## The mark
 *
 * A keyhole. Not a padlock — every password manager is a padlock, and at 16 pixels they are
 * indistinguishable from each other and from a browser's own address-bar icon. A keyhole is
 * the thing the name says, it survives being 16 pixels wide, and it reads as "the way in" more
 * than as "locked", which is the right feeling for an app you open forty times a day.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = resolve(HERE, '..', 'build');

// ── The geometry, in fractions of the canvas ─────────────────────────────────
//
// Fractions rather than pixels so one definition serves 16 and 1024 alike. Every number here
// was chosen against the 16-pixel rendering, because that is the size that decides whether an
// icon works — a mark that only reads at 512 is a mark nobody sees.

/** Apple's continuous-corner radius, near enough for a shape this simple. */
const CORNER = 0.2237;

/** The accent from the default theme, and its pressed state. One brand colour, two stops. */
const TOP = { r: 0x3d, g: 0x63, b: 0xdd };
const BOTTOM = { r: 0x23, g: 0x3c, b: 0x93 };

/** The keyhole, in white. */
const HOLE_CX = 0.5;
const HOLE_CY = 0.4;
const HOLE_R = 0.168;
/** The slot runs from inside the circle to here, widening as it goes. */
const SLOT_TOP = 0.43;
const SLOT_BOTTOM = 0.78;
const SLOT_HALF_TOP = 0.07;
const SLOT_HALF_BOTTOM = 0.132;

/** 4×4 per pixel. Enough that a 16-pixel keyhole has clean edges; cheap enough to be instant. */
const SAMPLES = 4;

// ── Sampling ─────────────────────────────────────────────────────────────────

/** Inside the rounded square? `x` and `y` are fractions of the canvas. */
function inPlate(x, y) {
  const dx = Math.min(x, 1 - x);
  const dy = Math.min(y, 1 - y);
  if (dx >= CORNER || dy >= CORNER) return true;
  const ox = CORNER - dx;
  const oy = CORNER - dy;
  return ox * ox + oy * oy <= CORNER * CORNER;
}

/** Inside the keyhole — the circle, or the tapered slot below it? */
function inHole(x, y) {
  const dx = x - HOLE_CX;
  const dy = y - HOLE_CY;
  if (dx * dx + dy * dy <= HOLE_R * HOLE_R) return true;
  if (y < SLOT_TOP || y > SLOT_BOTTOM) return false;
  const t = (y - SLOT_TOP) / (SLOT_BOTTOM - SLOT_TOP);
  return Math.abs(dx) <= SLOT_HALF_TOP + t * (SLOT_HALF_BOTTOM - SLOT_HALF_TOP);
}

/** The plate's vertical gradient at `y`. */
function plateColour(y) {
  return {
    r: Math.round(TOP.r + (BOTTOM.r - TOP.r) * y),
    g: Math.round(TOP.g + (BOTTOM.g - TOP.g) * y),
    b: Math.round(TOP.b + (BOTTOM.b - TOP.b) * y),
  };
}

/**
 * Renders the icon at `size`, as raw RGBA.
 *
 * Supersampled rather than analytically anti-aliased: the shape is a union of a rounded
 * rectangle, a circle and a trapezoid, and the exact coverage of that union at a corner where
 * all three meet is a great deal of arithmetic for a result 4×4 sampling already gets right.
 */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SAMPLES);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let plate = 0;
      let hole = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px * SAMPLES + sx + 0.5) * step;
          const y = (py * SAMPLES + sy + 0.5) * step;
          if (!inPlate(x, y)) continue;
          plate += 1;
          if (inHole(x, y)) hole += 1;
        }
      }

      const total = SAMPLES * SAMPLES;
      const at = (py * size + px) * 4;
      if (plate === 0) continue;

      const colour = plateColour((py + 0.5) / size);
      // The hole is white painted over the plate, so its edge blends against the plate rather
      // than against transparency — the difference between a crisp keyhole and a haloed one.
      const white = hole / plate;
      pixels[at] = Math.round(colour.r + (255 - colour.r) * white);
      pixels[at + 1] = Math.round(colour.g + (255 - colour.g) * white);
      pixels[at + 2] = Math.round(colour.b + (255 - colour.b) * white);
      pixels[at + 3] = Math.round((plate / total) * 255);
    }
  }

  return pixels;
}

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const pixels = render(size);

  // Filter byte 0 (None) on every scanline. Filtering would compress better and this is an
  // icon, not a photograph — the largest file here is a few tens of kilobytes either way, and
  // "None" is the one that is obviously correct.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // level 9 so the output is deterministic and small; the test regenerates and compares bytes.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO ──────────────────────────────────────────────────────────────────────

/** The sizes Windows actually asks for, smallest first. 256 is the one the Store wants. */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const at = index * 16;
    // 0 means 256 — the field is one byte, which is why 256 is the largest an ICO can name.
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

// ── ICNS ─────────────────────────────────────────────────────────────────────

/**
 * The OSTypes macOS reads, paired with the pixel size each one means.
 *
 * The `ic11`–`ic14` set are the retina variants — `ic11` is "16pt at 2×", so 32 pixels — and
 * they are separate entries holding the same images as their 1× counterparts at the next size
 * up. macOS picks by point size and scale, so omitting them gives a blurry icon on every Mac
 * made in the last decade.
 */
export const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
];

function icns(byteSize) {
  const blocks = ICNS_ENTRIES.map(([type, size]) => {
    const data = byteSize(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });

  const body = Buffer.concat(blocks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ── SVG ──────────────────────────────────────────────────────────────────────

/**
 * The same geometry as vectors, for the README and anywhere else a document needs the mark.
 *
 * Emitted from the constants above rather than kept as a file beside them, so it cannot drift
 * from what the app actually ships. The slot is a `<path>` because it is a trapezoid; the
 * `fill-rule` makes the keyhole a hole rather than a white shape sitting on top, which matters
 * on a dark background where the two look identical until they do not.
 */
function svg() {
  const f = (value) => (value * 1024).toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Keyhold">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#${TOP.r.toString(16)}${TOP.g.toString(16)}${TOP.b.toString(16)}"/>
      <stop offset="1" stop-color="#${BOTTOM.r.toString(16)}${BOTTOM.g.toString(16)}${BOTTOM.b.toString(16)}"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="${f(CORNER)}" ry="${f(CORNER)}" fill="url(#plate)"/>
  <g fill="#ffffff">
    <circle cx="${f(HOLE_CX)}" cy="${f(HOLE_CY)}" r="${f(HOLE_R)}"/>
    <path d="M ${f(HOLE_CX - SLOT_HALF_TOP)} ${f(SLOT_TOP)} L ${f(HOLE_CX + SLOT_HALF_TOP)} ${f(SLOT_TOP)} L ${f(HOLE_CX + SLOT_HALF_BOTTOM)} ${f(SLOT_BOTTOM)} L ${f(HOLE_CX - SLOT_HALF_BOTTOM)} ${f(SLOT_BOTTOM)} Z"/>
  </g>
</svg>
`;
}

// ── Writing them all ─────────────────────────────────────────────────────────

/** The PNGs Linux packaging and the README want, beside the two containers. */
export const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

export function buildIcons() {
  const cache = new Map();
  const at = (size) => {
    const existing = cache.get(size);
    if (existing !== undefined) return existing;
    const made = png(size);
    cache.set(size, made);
    return made;
  };

  const files = new Map();
  files.set('icon.svg', Buffer.from(svg(), 'utf8'));
  // electron-builder reads `build/icon.png` for Linux and as the fallback everywhere else.
  files.set('icon.png', at(1024));
  files.set('icon.ico', ico(ICO_SIZES.map((size) => ({ size, data: at(size) }))));
  files.set('icon.icns', icns(at));
  for (const size of PNG_SIZES) files.set(`icons/${size}x${size}.png`, at(size));

  return files;
}

function main() {
  const files = buildIcons();
  for (const [name, data] of files) {
    const path = join(BUILD, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    process.stdout.write(`${name.padEnd(24)} ${String(data.length).padStart(8)} bytes\n`);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  main();
}
