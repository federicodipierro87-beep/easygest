import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tutta la logica testata è pura o gira su Node: nessun ambiente DOM.
    // Quando il frontend avrà test di componenti aggiungerò un progetto jsdom
    // separato, non un ambiente globale più lento per tutti.
    environment: 'node',
    // I test del frontend rientrano qui perché riguardano moduli deliberatamente
    // privi di React: lo store di sessione è logica, e va provata come tale.
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/api/src/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/web/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
    },
  },
});
