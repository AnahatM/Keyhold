// SPDX-License-Identifier: GPL-3.0-or-later
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Two test environments, because the two halves of the app have different rules:
 *
 *   node  — src/main, src/preload, src/shared, tools. Real crypto, real fs.
 *           This is where the security-critical tests live.
 *   jsdom — src/renderer. UI logic only; there are no secrets here to test.
 *
 * Testing policy is in CLAUDE.md: core systems only, no ceremonial tests,
 * no coverage target.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve('src/main'),
      '@preload': resolve('src/preload'),
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/preload/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'tools/**/*.test.{ts,js}',
            'tests/node/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}', 'tests/renderer/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
