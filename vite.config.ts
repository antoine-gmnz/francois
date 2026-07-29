/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 8080, strictPort: true },
  // Unit tests target the pure helpers in contract/ + src/ — node env, no DOM needed.
  // packaging/ holds the dependency-free npm distribution package (plain CJS, so
  // its tests are .mjs and reach it through createRequire).
  test: {
    environment: 'node',
    include: ['{src,contract}/**/*.test.ts', 'packaging/**/*.test.mjs'],
  },
});
