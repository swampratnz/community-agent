// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'whatsapp-auth/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Real bug classes for a bot with async send/confirm paths — keep ON.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Lenient-then-ratchet: these fight the existing style without
      // catching the security-relevant bug classes above.
      '@typescript-eslint/no-unused-vars': 'off', // tsc noUnusedLocals/noUnusedParameters already enforce this
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // The one-way import rule (agent-base plan §Phase-2): src/base/ is the
    // community-agnostic framework and must stay liftable into the agent-base
    // package on its own, so it may never import src/module/. Patterns cover
    // every depth of `../` a base file could climb, and `allowTypeImports` is
    // deliberately NOT set — a type-level dependency is still a design
    // dependency, and a `typeof <community export>` in a deps interface is the
    // exact edge this repo kept re-growing.
    //
    // This is the fast local half of the rule. The authoritative half is
    // scripts/check-import-direction.mjs, which resolves each specifier against
    // the file system instead of matching its text, and runs in CI's lint job.
    files: ['src/base/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/module/**', '**/module', '../../index.js', '../index.js'],
              message:
                'src/base/ must not import src/module/ (or the composition root). Declare a registry slot ' +
                'in base and let the module register into it at its own import time — see ' +
                'src/base/agent/turnState.ts or src/base/strings/catalogue.ts — or declare the type ' +
                'structurally in base. Verified by scripts/check-import-direction.mjs.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // node:test's `test(name, fn)` is fire-and-forget by design — the
      // runner tracks the returned promise itself, callers never await it.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  eslintConfigPrettier,
);
