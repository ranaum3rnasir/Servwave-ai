import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

/**
 * ESLint 9 flat config.
 *
 * `npm run lint` (`eslint .`) had no config file at all, so it exited 2 on every
 * run and the repo has never had lint enforcement. This restores the stock
 * Vite react-ts setup (all plugins were already in devDependencies).
 *
 * Deliberately NOT type-checked (`recommendedTypeChecked`): the codebase has
 * never been linted, so the strictest preset would bury real findings under
 * thousands of pre-existing ones. Start enforceable, tighten later.
 */
export default tseslint.config(
  {
    // Legacy `eslint-disable` comments reference rules this config does not
    // (yet) enable - notably `no-console`. They are harmless, and flagging all
    // of them would bury the real findings while the repo re-adopts linting.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      'dist',
      'coverage',
      'node_modules',
      'e2e/**',
      'playwright-report',
      '*.config.js',
      '*.config.ts',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Unused vars are worth seeing, but the leading-underscore escape hatch
      // keeps intentionally-ignored args (e.g. `_req`) from being noise.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // 'warn' never fails CI, so this rule alone enforced nothing - the raw-tag
    // ratchet in component-api-guard.test.ts is the real gate today. Widened
    // to include src/features/** (raw-tag-ratchet PR, 2026-07-30): it had 9
    // raw <button> sites of its own (src/features/estimate-workspace/) that
    // this glob never saw.
    files: ['src/components/**/*.tsx', 'src/pages/**/*.tsx', 'src/features/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector: "JSXOpeningElement[name.name='button']",
          message:
            'Use <Button> from @/components/ui/button instead of a raw <button> element.',
        },
      ],
    },
  },
  {
    // Subdirectories with ZERO raw <button> occurrences, measured fresh
    // 2026-07-30 (same boundary-safe, multi-line-aware scan as the raw-tag
    // ratchet's RAW_TAG_CEILINGS.button in component-api-guard.test.ts).
    // Promoted from 'warn' to 'error' here, scoped to exactly these paths, so
    // a new raw <button> in an already-clean directory fails CI immediately
    // instead of silently warning. Flat config applies rules from later
    // matching entries last, so this block - listed after the broader 'warn'
    // block above - wins for these paths without needing to touch it.
    //
    // Every other subdirectory under src/components/**, src/pages/** and
    // src/features/** still has at least one raw <button> today and stays at
    // 'warn' via the block above; do not add one here without re-measuring -
    // an incorrect addition breaks the build for everyone touching that
    // directory, not just the offending call site.
    files: [
      'src/components/__tests__/**/*.tsx',
      'src/components/brand/**/*.tsx',
      'src/components/charts/**/*.tsx',
      'src/components/payments/**/*.tsx',
      'src/pages/service-plans/**/*.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXOpeningElement[name.name='button']",
          message:
            'Use <Button> from @/components/ui/button instead of a raw <button> element.',
        },
      ],
    },
  },
  {
    // Tests use jsdom + vitest globals. `no-explicit-any` stays ON here: the
    // suites already carry targeted `eslint-disable` comments for it, so
    // blanket-disabling would silently invalidate that existing intent.
    files: ['**/*.test.{ts,tsx}', 'src/__tests__/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
);
