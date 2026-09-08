// Dotenv va importato a mano: dalla 7 Prisma non legge più `.env` da solo.
// In produzione non serve, perché le variabili le inietta Railway, ma
// `--env-file-if-exists` non copre i comandi della CLI.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Configurazione della CLI Prisma.
 *
 * Dalla versione 7 l'URL del database non sta più nello `schema.prisma`: le
 * migrazioni lo leggono da qui, il client applicativo lo riceve invece da un
 * driver adapter esplicito (vedi `src/db/client.ts`). Sono due percorsi
 * distinti di proposito, e vanno tenuti allineati sulla stessa variabile.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Si legge `process.env` e non l'helper `env()` di Prisma, che solleva
    // un'eccezione appena il file viene caricato: `prisma generate` gira anche
    // in `postinstall`, dove il database non serve e la variabile può non
    // esserci ancora, e farebbe fallire l'installazione a chi clona il
    // repository. I comandi che il database lo toccano davvero falliscono
    // comunque, ma solo quando è giusto che falliscano.
    url: process.env.DATABASE_URL ?? '',
  },
});
