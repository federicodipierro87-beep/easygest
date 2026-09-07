/// <reference types="vite/client" />

/**
 * Senza questa dichiarazione `import.meta.env.VITE_API_URL` è tipizzato `any`
 * dall'index signature di Vite, e un refuso nel nome della variabile passerebbe
 * il typecheck per poi rompersi solo in produzione.
 *
 * Il tipo è volutamente `string | undefined`: la variabile può davvero mancare,
 * ed è compito di `src/lib/env.ts` accorgersene e dirlo chiaramente.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
