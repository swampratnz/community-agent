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
    // The composition-direction rules (agent-base package flip). `src/module/`
    // is this deployment's content; `src/index.ts` is the only file that
    // composes it. Two things it may never do:
    //
    //   - import the composition root, which sits at the top of the graph;
    //   - import a composition entry point from the package — a module
    //     CONTRIBUTES a manifest (src/module/agentModule.ts), it never
    //     composes one, because the registration ORDER is precisely what
    //     `createAgent` exists to own.
    //
    // `allowTypeImports` is deliberately NOT set for the composition root: a
    // type-level dependency is still a design dependency. The manifest TYPE
    // (`AgentModuleManifest`) is a different import and stays allowed.
    //
    // This is the fast local half of the rule. The authoritative half is
    // scripts/check-import-direction.mjs, which resolves each specifier against
    // the file system (and additionally fails if `src/base/` is ever
    // re-created), and runs in CI's lint job.
    files: ['src/module/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/src/index.js', '../index.js', '../../index.js', '../../../index.js'],
              message:
                'src/module/ must not import the composition root. src/index.ts wires this module; ' +
                'nothing it wires may reach back up to it. Verified by ' +
                'scripts/check-import-direction.mjs.',
            },
          ],
          paths: [
            {
              name: '@swampratnz/agent-base',
              importNames: ['createAgent', 'planComposition', 'assertRegistrationsComplete'],
              message:
                'Only src/index.ts composes the agent. A module exports an AgentModuleManifest ' +
                '(src/module/agentModule.ts) and the composition root hands it to createAgent, which ' +
                'owns the ordering: plan, init, singleton registrations, additive registrations, ' +
                'readiness probe, migrate, start.',
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
