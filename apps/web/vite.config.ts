import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in dev, so the client never needs an absolute API base URL.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
});
