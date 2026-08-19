import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Listen on the LAN, not just loopback, so the dev server can be opened
    // from a second machine. Production does not need this: there the API
    // serves the built app itself, on one port.
    host: true,
    // In dev the API runs on :3001; in production the API serves this build
    // itself, so the app can always call relative /api/* URLs.
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
