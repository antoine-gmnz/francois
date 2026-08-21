/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // The demo backend (src/demo/, README screenshot + GIF captures only) must
  // leave NO trace in a shipped build. A bare `import.meta.env.VITE_FRANCOIS_DEMO`
  // is not statically replaced when the variable is unset, so the comparison
  // survives minification and drags the whole fake fleet into the bundle.
  // Substituting a literal `false` here makes every `if (DEMO)` dead code that
  // Rollup eliminates, taking the fixtures with it.
  define: {
    __FRANCOIS_DEMO__: JSON.stringify(process.env.VITE_FRANCOIS_DEMO === '1'),
  },
  // Unit tests target the pure helpers in contract/ + src/ — node env, no DOM needed.
  // packaging/ holds the dependency-free npm distribution package (plain CJS, so
  // its tests are .mjs and reach it through createRequire). scripts/ holds the CI
  // release helpers, .mjs for the same reason: nothing may depend on a build step.
  test: {
    environment: 'node',
    include: ['{src,contract}/**/*.test.ts', '{packaging,scripts}/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'reports/coverage',
      // text for the terminal, lcov for Codecov-style tools, json-summary for
      // the CI job summary, html to actually read a file's uncovered lines.
      reporter: ['text-summary', 'lcov', 'json-summary', 'html'],
      // Only what the tests are meant to cover: pure helpers, stores, hooks and
      // the contract-typed wrappers. Components are not unit-tested (no DOM
      // framework is wired — see PIPELINE.md §Testing), so counting .tsx would
      // report a number that measures the testing STRATEGY rather than the
      // suite, and a number nobody can act on gets ignored.
      include: ['src/**/*.ts', 'contract/**/*.ts', 'scripts/**/*.mjs', 'packaging/**/*.js'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.mjs',
        '**/testutil.ts',
        'src/demo/**', // stripped from shipped builds by the `define` above
        'src/main.tsx',
        'src/**/*.d.ts',
      ],
      // No global threshold on purpose: a single repo-wide percentage is a
      // number people game. The report is the artefact; ratcheting specific
      // directories is a separate, deliberate decision.
      thresholds: undefined,
    },
  },
});
