import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nirnamPlugin } from '@palinc/nirnam/vite';

export default defineConfig({
  server: { port: 3200 },
  plugins: [
    react(),
    nirnamPlugin(),
  ],
});
