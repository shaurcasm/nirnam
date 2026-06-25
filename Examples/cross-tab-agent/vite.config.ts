import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nirnamPlugin } from '@palinc/nirnam/vite';

export default defineConfig({
  server: { port: 3300 },
  plugins: [
    react(),
    nirnamPlugin(), // copies worker to public/ + injects __NIRNAM_STATIC_WORKER_URL__
  ],
});
