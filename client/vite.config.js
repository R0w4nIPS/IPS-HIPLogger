import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development the Vite dev server proxies API + WebSocket traffic
// to the Node server on :8080, so the client code can always use
// relative URLs regardless of environment.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
});
