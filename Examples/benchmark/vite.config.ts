import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    port: 3400,
    // The effort panel reads the library's own source with `?raw`, two levels up.
    fs: { allow: ['../..'] },
  },
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
