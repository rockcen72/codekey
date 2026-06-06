import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_TELEGRAM_WORKER_URL || 'https://codekeyapi.ccwu.cc',
        changeOrigin: true,
      },
      '/auth': {
        target: process.env.VITE_TELEGRAM_WORKER_URL || 'https://codekeyapi.ccwu.cc',
        changeOrigin: true,
      },
      '/devices': {
        target: process.env.VITE_TELEGRAM_WORKER_URL || 'https://codekeyapi.ccwu.cc',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
