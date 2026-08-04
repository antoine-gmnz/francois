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
  },
});
