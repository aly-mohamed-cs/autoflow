import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the dashboard talks to a local Orchestrator (pnpm --filter @autoflow/server dev).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target: process.env.AUTOFLOW_API ?? 'http://127.0.0.1:8080', changeOrigin: false },
      '/downloads': { target: process.env.AUTOFLOW_API ?? 'http://127.0.0.1:8080' },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 3000 },
});
