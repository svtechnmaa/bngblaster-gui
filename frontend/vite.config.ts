import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Absolute base so deep links (e.g. /bngblaster-gui/admin/users) resolve
  // assets against the app root, not the current route. Override with
  // VITE_BASE_PATH (e.g. '/') for a root deployment.
  base: process.env.VITE_BASE_PATH ?? '/bngblaster-gui/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 3001,
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
    },
  },
});
