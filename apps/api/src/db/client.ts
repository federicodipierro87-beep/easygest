import { PrismaPg } from '@prisma/adapter-pg';

import type { Env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Client Prisma.
 *
 * Dalla versione 7 il client non apre più la connessione da sé: riceve un
 * driver adapter, cioè un pool `pg` vero e proprio. Il vantaggio pratico è che
 * il pool è configurabile qui, con numeri scelti da noi invece che impliciti.
 */
export function createPrismaClient(env: Env) {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,

    /**
     * Railway limita le connessioni del piano gestito, e ogni replica dell'API
     * più il servizio cron attingono allo stesso Postgres. Dieci connessioni
     * per processo lasciano margine: esaurire il pool del database si manifesta
     * come un'applicazione che si blocca senza errori, ed è sgradevole da
     * diagnosticare.
     */
    max: env.DATABASE_POOL_MAX,

    /** Una query che non torna entro trenta secondi non tornerà mai. */
    statement_timeout: 30_000,
    /** Idem per l'attesa di un lock: meglio fallire che restare appesi. */
    lock_timeout: 10_000,
  });

  return new PrismaClient({
    adapter,
    /**
     * Tutto come evento, niente su stdout: quello che Prisma scrive da sé
     * esce come testo libero e non come JSON di pino, quindi su Railway
     * finirebbe fuori dall'indice dei log proprio nel momento in cui lo stai
     * cercando. Chi si iscrive a questi eventi è `plugins/prisma.ts`.
     *
     * La lista è fissa e non dipende dall'ambiente perché è ciò che rende
     * `$on` tipizzato: con una lista costruita a runtime TypeScript non può
     * sapere quali eventi esistono.
     */
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });
}

/**
 * Il tipo del client così com'è configurato qui sopra.
 *
 * Va derivato e non scritto a mano: `PrismaClient` senza parametri perde la
 * configurazione dei log, e con essa la conoscenza di quali eventi esistono.
 * Il risultato è che `$on('query')` non compila, con un messaggio che parla di
 * `never` e non dice affatto dove sia il problema.
 */
export type AppPrismaClient = ReturnType<typeof createPrismaClient>;
