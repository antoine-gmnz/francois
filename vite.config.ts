/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Unit tests target the pure helpers in contract/ + src/ — node env, no DOM needed.
  test: {
    environment: 'node',
    include: ['{src,contract}/**/*.test.ts'],
  },
});
