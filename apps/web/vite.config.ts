import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    /**
     * Riproduce in sviluppo il proxy che in produzione fa Netlify: `/api/*`
     * arriva all'API sulla 3001, e il prefisso viene tolto perché le rotte
     * dell'API stanno sulla radice.
     *
     * Non è una comodità, è ciò che rende lo sviluppo rappresentativo: senza,
     * in locale il cookie di sessione sarebbe cross-origin e in produzione no,
     * e i problemi di autenticazione si vedrebbero solo dopo il deploy.
     */
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
