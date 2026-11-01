import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The backend owns all secrets; the frontend only ever talks to it.
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
});
