import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Serve solo a trasformare il JSX dei test dei componenti: il resto della
  // suite non tocca React.
  plugins: [react()],
  resolve: {
    alias: {
      // Lo stesso alias di `apps/web/vite.config.ts`. Va ripetuto perché
      // Vitest legge questo file e non quello: senza, i test dei componenti
      // non risolvono `@/components/...`.
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    // Nessun ambiente DOM: la logica è pura o gira su Node, e i componenti si
    // provano con `renderToString`, che di un DOM non ha bisogno.
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/api/src/**/*.test.ts',
      // I test del frontend rientrano qui perché riguardano moduli
      // deliberatamente privi di React: lo store di sessione è logica, e va
      // provata come tale.
      'apps/web/src/**/*.test.ts',
      'apps/web/src/**/*.test.tsx',
    ],
    // `apps/web/src/lib/env.ts` fallisce di proposito se manca: è la garanzia
    // che una build senza configurazione non arrivi silenziosamente in
    // produzione. Nei test il valore va quindi fornito, e questo è quello vero.
    env: { VITE_API_URL: '/api' },
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/web/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
    },
  },
});
