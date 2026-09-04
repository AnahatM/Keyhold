// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Typed by `make-icons.d.ts`. The script itself is plain JavaScript on purpose — it is a
// build step that runs before anything is compiled — and the declaration is what keeps `any`
// from leaking out of this import into the rest of the suite.
import { buildIcons, ICNS_ENTRIES, ICO_SIZES, PNG_SIZES } from './make-icons.mjs';

/**
 * Guard: the committed icons are the ones `tools/make-icons.mjs` produces, and every container
 * is structurally valid.
 *
 * Two failures this exists to catch, and they are different in kind.
 *
 * **Drift.** An icon edited by hand — in a paint program, by a resize, by anything — and
 * committed without its source is an asset nobody can regenerate, and the next change to the
 * brand colour silently leaves it behind. The script is the source; these files are output.
 * Regenerating and comparing bytes is the only way that stays true, and it is why the renderer
 * is deterministic.
 *
 * **A container that is not what it claims to be.** ICO and ICNS are both formats where a
 * wrong offset produces a file that every tool accepts and Windows or macOS silently declines
 * to draw. Nothing in `npm run build` opens them, and `npm run package` is a manual step
 * nobody runs often — so a broken icon would ship, and the first report would be "the app has
 * the default Electron icon", months later. Parsing them back here costs milliseconds.
 *
 * ## Fault injections performed
 *
 * 1. **The ICO directory's `imageOffset` shifted by one.** First attempt: only the drift case
 *    failed, because the structural checks were reading the *committed* file, which the
 *    injection had not touched. That is the right answer to the wrong question — a generator
 *    bug reported as "the file changed". The structural blocks now parse what the script
 *    produces, and re-injected, `every ICO entry points at a real PNG` fails on entry 0 with
 *    the exact corruption Windows shows as a blank icon.
 * 2. **`ic10` dropped from the ICNS entry list.** `the ICNS carries a 1024-pixel image` failed;
 *    without it macOS has nothing to draw at retina Finder sizes and upscales the 512.
 * 3. **`HOLE_R` nudged by 0.001.** Every "matches the committed file" case failed, which is
 *    the drift guard working — a change to the mark has to be committed with its output.
 * 4. **PNG filter byte changed from 0 to 1.** Caught by the byte comparison, but *not* by the
 *    header checks, which is worth saying: these tests verify structure and provenance, not
 *    that the image looks right. Nothing automated can do that, and the rendering was checked
 *    by eye at 16, 32 and 256 pixels — the sizes that decide it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = resolve(HERE, '..', 'build');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const generated = buildIcons();

/** The bytes on disk — what ships. Only the drift block reads these. */
function committed(name: string): Buffer {
  return readFileSync(join(BUILD, name));
}

/**
 * The bytes the script produces — what the structural checks below parse.
 *
 * Deliberately not the committed file. The drift block already proves the two are identical,
 * so parsing the committed one would make every structural case a second copy of that
 * comparison: a generator bug would be reported as "the file changed" rather than as "the ICO
 * offset is wrong", and it would only be caught *after* somebody regenerated. Injecting a
 * one-byte offset shift showed exactly that — the structural case passed and only the drift
 * case failed, which is the right answer to the wrong question.
 */
function made(name: string): Buffer {
  const data = generated.get(name);
  expect(data, `the script did not produce ${name}`).toBeDefined();
  return data ?? Buffer.alloc(0);
}

/** A PNG's declared dimensions, read out of its IHDR. */
function pngSize(data: Buffer): { width: number; height: number } {
  expect(data.subarray(0, 8)).toEqual(PNG_MAGIC);
  expect(data.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

describe('the committed icons are the generated ones', () => {
  it.each([...generated.keys()])('%s matches the committed file', (name) => {
    expect(
      committed(name).equals(generated.get(name) ?? Buffer.alloc(0)),
      `build/${name} is not what tools/make-icons.mjs produces — run \`npm run icons\``
    ).toBe(true);
  });

  it('writes every size the packagers ask for', () => {
    for (const size of PNG_SIZES) {
      expect([...generated.keys()]).toContain(`icons/${String(size)}x${String(size)}.png`);
    }
    expect([...generated.keys()]).toContain('icon.png');
    expect([...generated.keys()]).toContain('icon.ico');
    expect([...generated.keys()]).toContain('icon.icns');
    expect([...generated.keys()]).toContain('icon.svg');
  });

  it('is deterministic, which is what makes comparing bytes meaningful', () => {
    const again = buildIcons();
    for (const [name, data] of generated) {
      expect(again.get(name)?.equals(data), `${name} differs between two runs`).toBe(true);
    }
  });
});

describe('the PNGs', () => {
  it.each([...PNG_SIZES])('icons/%ix%i.png is that many pixels square', (size) => {
    expect(pngSize(made(`icons/${String(size)}x${String(size)}.png`))).toEqual({
      width: size,
      height: size,
    });
  });

  it('icon.png is 1024, which is what electron-builder wants as the source', () => {
    // electron-builder refuses anything under 256 and downscales from this for Linux.
    expect(pngSize(made('icon.png'))).toEqual({ width: 1024, height: 1024 });
  });
});

describe('the Windows .ico', () => {
  const ico = made('icon.ico');

  it('declares an icon directory with one entry per size', () => {
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // 1 = icon, 2 = cursor
    expect(ico.readUInt16LE(4)).toBe(ICO_SIZES.length);
  });

  it('every entry points at a real PNG of the size it claims', () => {
    // The check that catches a wrong offset, which is the failure mode that ships: the file
    // is well-formed, every tool opens it, and Windows draws nothing.
    ICO_SIZES.forEach((size, index) => {
      const at = 6 + index * 16;
      const declared = ico[at] === 0 ? 256 : ico[at];
      expect(declared, `entry ${String(index)} declares the wrong width`).toBe(size);

      const length = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      expect(offset + length, `entry ${String(index)} runs past the end`).toBeLessThanOrEqual(
        ico.length
      );

      const image = ico.subarray(offset, offset + length);
      expect(pngSize(image), `entry ${String(index)} is not a ${String(size)}px PNG`).toEqual({
        width: size,
        height: size,
      });
    });
  });

  it('includes 256, which is the size the Windows shell asks for most', () => {
    expect(ICO_SIZES).toContain(256);
  });
});

describe('the macOS .icns', () => {
  const icns = made('icon.icns');

  it('is an icns whose declared length is its real one', () => {
    expect(icns.subarray(0, 4).toString('latin1')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
  });

  it('walks cleanly from block to block, each holding a PNG of its declared size', () => {
    // A length that is off by a byte desynchronises every block after it, and the file still
    // opens — macOS simply draws whichever blocks it managed to read.
    const seen = new Map<string, number>();
    let at = 8;

    while (at < icns.length) {
      const type = icns.subarray(at, at + 4).toString('latin1');
      const length = icns.readUInt32BE(at + 4);
      expect(length, `block ${type} declares an impossible length`).toBeGreaterThan(8);
      expect(at + length, `block ${type} runs past the end`).toBeLessThanOrEqual(icns.length);

      const image = icns.subarray(at + 8, at + length);
      seen.set(type, pngSize(image).width);
      at += length;
    }

    expect(at, 'the blocks do not add up to the file length').toBe(icns.length);
    for (const [type, size] of ICNS_ENTRIES) {
      expect(seen.get(type), `${type} is missing or the wrong size`).toBe(size);
    }
  });

  it('carries a 1024-pixel image, without which retina Finder upscales the 512', () => {
    expect(ICNS_ENTRIES.some(([, size]) => size === 1024)).toBe(true);
  });

  it('carries the retina variants, not only the 1× set', () => {
    // `ic11`–`ic14` are the 2× entries. Omitting them gives a blurry icon on every Mac made in
    // the last decade, and nothing warns about it.
    const types = ICNS_ENTRIES.map(([type]) => type);
    for (const retina of ['ic11', 'ic12', 'ic13', 'ic14']) {
      expect(types).toContain(retina);
    }
  });
});

describe('the SVG', () => {
  it('is the same mark, as vectors, for documents', () => {
    const svg = made('icon.svg').toString('utf8');

    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    // Labelled, because it is used as an image in the README and in the docs.
    expect(svg).toContain('aria-label="Keyhold"');
  });
});
