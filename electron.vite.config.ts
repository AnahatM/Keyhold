// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { collectLicences } from './tools/licences.js';

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };

/**
 * Path aliases live here AND in tsconfig.node.json / tsconfig.web.json.
 * `tools/alias-parity.test.ts` fails if the two ever drift apart — keeping them in
 * sync by hand is exactly the kind of thing that rots silently.
 */
const alias = {
  '@main': resolve('src/main'),
  '@preload': resolve('src/preload'),
  '@renderer': resolve('src/renderer/src'),
  '@shared': resolve('src/shared'),
};

/** Baked in at build time so the app can report its version without reading a file. */
const define = { APP_VERSION: JSON.stringify(pkg.version) };

/**
 * The third-party licence list, baked into the renderer at build time.
 *
 * **Build time is the only route that works.** `electron-builder.yml`'s `files` block is an
 * allow-list of `out/**` plus `package.json`, so `tools/` never ships and a runtime
 * `kh:app:licences` handler would have no module to call — it would work in `npm run dev`
 * and return nothing from an installed app, which is the worst of the two failures because
 * only the users see it.
 *
 * Derived from the production dependency closure rather than written down. `tools/licences.ts`
 * carries a guard that fails if the module ever hard-codes a package name, version or
 * licence, because a hand-maintained list of legal notices is a list that goes quietly wrong.
 */
const RENDERER_DEFINE = {
  ...define,
  THIRD_PARTY_LICENCES: JSON.stringify(collectLicences(resolve('.'))),
};

export default defineConfig({
  main: {
    resolve: { alias },
    define,
    build: {
      // Default; stated explicitly so an upstream default change cannot silently
      // start inlining node_modules into the main bundle.
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // A second entry, not a chunk: it is loaded by `new Worker(<path>)` at runtime,
          // so it must exist as its own file at a predictable name. Argon2 runs here to
          // keep the main thread — and therefore the window — responsive during unlock.
          'kdf-worker': resolve('src/main/crypto/kdf-worker.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    define,
    build: {
      // The preload runs with `sandbox: true` (src/main/security.ts). Electron runs
      // sandboxed preloads as plain CommonJS with no ESM context, so this bundle must
      // be CJS — an .mjs preload silently fails to load at runtime, which is the kind
      // of bug that only shows up as "the bridge is unavailable" in the UI.
      // https://www.electronjs.org/docs/latest/tutorial/esm
      //
      // `externalizeDeps: false` for the same reason: a sandboxed preload cannot
      // require out of node_modules, so everything it needs is bundled inline.
      // Only `electron` itself stays external — that is the one module the sandbox
      // does provide.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: { alias },
    define: RENDERER_DEFINE,
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
});
