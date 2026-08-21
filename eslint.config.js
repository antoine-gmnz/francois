// Flat config (ESLint 9). Pinned to 9.x deliberately: ESLint 10 requires Node
// ^20.19 || ^22.13 || >=24, which would make the pre-commit hook fail on any
// checkout still running Node 18. Same flat-config shape, so the bump is a
// version change and nothing else.
//
// Scope: the `src/` + `contract/` TypeScript surface only. The Rust surface is
// linted by clippy (see src-tauri/Cargo.toml `[lints]`), and the repo-specific
// layout conventions from CLAUDE.md live in scripts/quality/conventions.mjs
// because several of them span both surfaces.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    // Nothing generated, vendored, or built is ours to lint.
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/target/**',
      'packaging/vendor/**',
      'packaging/manifest.json',
      'coverage/**',
      'reports/**',
      '**/*.dc.html',
    ],
  },

  // ── TypeScript + React (src/, contract/) ─────────────────────────────────
  {
    files: ['{src,contract}/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, __FRANCOIS_DEMO__: 'readonly' },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // The rule that justifies the whole setup: `tsc` cannot see a stale
      // dependency array, and this repo's hooks are where a missed dep turns
      // into a transcript that silently stops updating.
      //
      // WARN, not error — 13 pre-existing sites (`npm run lint:deps` lists
      // them). Several are load-bearing: ShellTerminal.tsx's mount effect would
      // respawn the PTY if `sessionId`/`initialData` were added, and
      // useDiffFeed.ts needs its `files` expression wrapped in useMemo first.
      // Those are behaviour changes, not lint fixes, so they belong in their
      // own PR. Promote to 'error' once that backlog is clear.
      'react-hooks/exhaustive-deps': 'warn',

      // Fast Refresh only works if a module exports components and nothing
      // else; a stray helper export makes the whole file remount on edit.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // `catch (e) {}` and `const x = await f()` with x unused are real bugs;
      // a leading underscore is the opt-out, matching the Rust convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // Existing debt (~90 sites at the time of writing) — warn so it shows in
      // the report and blocks nothing, per the ratchet.
      '@typescript-eslint/no-explicit-any': 'warn',

      // CLAUDE.md §Code layout: "Styling is per-feature CSS + classNames, never
      // inline style={{}}", the exception being a value computed at runtime.
      // ~87 existing sites, so this is a warn: it gates new code via the report
      // without demanding a mass CSS migration first.
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'JSXAttribute[name.name="style"] > JSXExpressionContainer > ObjectExpression',
          message:
            'CLAUDE.md: styling is per-feature CSS + classNames. Inline style={{}} is only for a value computed at runtime — if that is the case here, add an eslint-disable-next-line with the reason.',
        },
      ],

      // CLAUDE.md §Code layout: "No barrel files anywhere — import the module
      // directly", and features must not reach into each other's folders.
      // Shared code goes to src/lib, src/ui, or contract/.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/features/*/index', '**/features/*/index.ts'],
              message: 'CLAUDE.md: no barrel files — import the module directly.',
            },
          ],
        },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Tests may reach for `any` and non-null assertions freely; they are not
  // shipped and the strictness buys nothing there.
  {
    files: ['**/*.test.{ts,tsx}', '**/testutil.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // The demo fleet is dead code in a shipped build (vite `define` strips it),
  // and it deliberately fabricates data.
  {
    files: ['src/demo/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  // ── Zero-dependency ESM/CJS helpers (scripts/, packaging/) ───────────────
  // Not a surface, no TypeScript, no build step — they run under bare node.
  {
    files: ['{scripts,packaging}/**/*.{mjs,js}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // These are CLI helpers; printing is the point.
      'no-console': 'off',
    },
  },
  {
    files: ['packaging/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
  },

);

// NOTE on `no-control-regex`: the handful of legitimate uses (sanitizing C0/C1
// and bidi code points out of untrusted manifest text; asserting on ANSI escapes
// in tests) are suppressed with LOCAL directives at each site, not with a
// files-based override here. That is the convention the codebase already had,
// and it matters: a blanket override would make those existing
// `eslint-disable-next-line` comments "unused", and `eslint --fix` deletes
// unused directives — silently removing the comment that documented why the
// control characters are deliberate.
