import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  dts: false,
  // `@easygest/shared` è pubblicato come sorgente TypeScript e non ha una
  // build propria: lo si compila qui insieme all'API. Un pacchetto interno in
  // meno da tenere allineato.
  noExternal: ['@easygest/shared'],
});
