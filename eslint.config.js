// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import keyhold from './tools/eslint-rules/spdx-header.js';

/**
 * Four zones with genuinely different rules:
 *
 *   main / preload / shared — Node. Owns every secret. The strictest zone.
 *   renderer                — browser + React. Must NEVER reach Node or a secret.
 *   tests                   — a few assertions relaxed, nothing security-relevant.
 *   plain .js tooling       — linted, but not type-checked (it is outside both tsconfigs).
 */
export default defineConfig([
  globalIgnores(['out/**', 'dist/**', 'release/**', 'node_modules/**', 'coverage/**', '**/*.d.ts']),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { keyhold },
    rules: {
      'keyhold/spdx-header': 'error',

      // ── Security-critical bans ────────────────────────────────────────────
      // Math.random is not a CSPRNG. It must never produce a salt, a nonce, an id,
      // or a generated password. There is no legitimate use for it in this codebase,
      // so it is banned outright rather than reviewed case by case.
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Math.random() is not cryptographically secure. Use crypto.randomBytes() in the main process, or the shared random helper.',
        },
      ],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // ── Correctness ───────────────────────────────────────────────────────
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'multi-line'],
    },
  },

  // ── Main, preload, shared: Node, and the only place secrets may exist ────
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // A secret reaching a log is a leak, not a debugging convenience.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // ── Renderer: browser only. Must not reach for Node. ─────────────────────
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // The renderer is a semi-trusted zone (decision D13). It has no Node access by
      // construction (sandbox + contextIsolation); importing these would mean someone
      // tried to widen that hole.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*', 'fs', 'path', 'crypto', 'child_process', 'os'],
              message:
                'The renderer has no Node access by design. Go through window.keyhold.* (the preload bridge) instead.',
            },
            {
              group: ['@main/*'],
              message:
                'The renderer must not import main-process code — that is where the keys live. Use the IPC contract in @shared/ipc.',
            },
          ],
        },
      ],
    },
  },

  // ── Tests ────────────────────────────────────────────────────────────────
  {
    files: ['**/*.test.{ts,tsx,js,mjs}', 'tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      'no-restricted-properties': 'off',
    },
  },

  // ── Plain .js tooling ────────────────────────────────────────────────────
  // These sit outside both tsconfigs on purpose: they are build/lint machinery,
  // not application code. They are still linted, just not type-aware — running
  // typed rules against a file with no program produces noise, not findings.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: false, project: false },
    },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': 'off',
    },
  },

  // ── Config files ─────────────────────────────────────────────────────────
  {
    files: ['*.config.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/explicit-module-boundary-types': 'off' },
  },

  // Prettier last — it only turns formatting rules off.
  prettier,
]);
