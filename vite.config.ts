/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Unit tests target the pure helpers in contract/ + src/ — node env, no DOM needed.
  // packaging/ holds the dependency-free npm distribution package (plain CJS, so
  // its tests are .mjs and reach it through createRequire). scripts/ holds the CI
  // release helpers, .mjs for the same reason: nothing may depend on a build step.
  test: {
    environment: 'node',
    include: ['{src,contract}/**/*.test.ts', '{packaging,scripts}/**/*.test.mjs'],
  },
});
