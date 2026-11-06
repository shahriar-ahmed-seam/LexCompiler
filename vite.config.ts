import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // The API, the MCP endpoint with its OAuth and discovery documents, and the HTML check pages.
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/.well-known': { target: 'http://localhost:3001', changeOrigin: true },
      '/mcp': { target: 'http://localhost:3001', changeOrigin: true },
      '/oauth': { target: 'http://localhost:3001', changeOrigin: true },
      '/scans': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
