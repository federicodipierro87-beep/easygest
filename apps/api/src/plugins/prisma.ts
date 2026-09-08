import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import type { Env } from '../config/env';
import { type AppPrismaClient, createPrismaClient } from '../db/client';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: AppPrismaClient;
  }
}

/**
 * Rende il client Prisma disponibile come `app.prisma` e lo chiude insieme
 * all'applicazione.
 *
 * `fastify-plugin` serve a non incapsulare il decoratore: senza, resterebbe
 * visibile solo dentro questo plugin e non nelle rotte registrate altrove.
 */
export const prismaPlugin = fp(
  async function prismaPlugin(app: FastifyInstance, env: Env): Promise<void> {
    const prisma = createPrismaClient(env);

    prisma.$on('warn', (event) => {
      app.log.warn({ prisma: event.message }, 'Prisma');
    });
    prisma.$on('error', (event) => {
      app.log.error({ prisma: event.message }, 'Prisma');
    });

    // Le query si registrano solo in sviluppo, dove servono a vedere una N+1 a
    // colpo d'occhio. In produzione no: il testo di una query contiene i dati
    // del cliente, e finirebbero in chiaro nei log della piattaforma.
    if (env.NODE_ENV === 'development') {
      prisma.$on('query', (event) => {
        app.log.debug({ query: event.query, durationMs: event.duration }, 'Query');
      });
    }

    // Inizializza il pool senza aspettare la prima richiesta. Attenzione a cosa
    // *non* fa: con un driver adapter `$connect()` non apre davvero una
    // connessione e non fallisce se il database è irraggiungibile o le
    // credenziali sono sbagliate — verificato spegnendo Postgres, l'API parte
    // lo stesso. A intercettare un deploy rotto è `/ready`, che una query la
    // esegue per davvero ed è l'healthcheck dichiarato in `.railway/railway.ts`.
    await prisma.$connect();

    app.decorate('prisma', prisma);

    app.addHook('onClose', async () => {
      await prisma.$disconnect();
    });
  },
  { name: 'prisma' },
);
