import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Env } from '../config/env';
import { jobContext, runJob } from '../jobs/runner';
import { JOB_NAMES } from '../jobs/types';
import { parseBody } from '../lib/validation';
import { requireUser } from '../plugins/auth';
import type { Fetcher } from '../services/frankfurter';

/**
 * L'esecuzione manuale dei lavori pianificati.
 *
 * Serve a una domanda sola, ed è la domanda che ci si fa il giorno del primo
 * deploy: «funziona davvero in produzione?». Aspettare le 07:00 del mattino
 * dopo per scoprirlo, e poi aspettarne un altro se non ha funzionato, è un
 * ciclo di verifica da ventiquattr'ore per una configurazione che si sbaglia
 * in tre modi diversi.
 *
 * **Protetta dalla sessione e non da un token condiviso.** Un secondo sistema
 * di credenziali da custodire, ruotare e non far finire nei log sarebbe un
 * costo permanente per un endpoint che non fa nulla che l'utente non possa già
 * fare sui propri dati — ed è vero solo perché il giro è ristretto al suo
 * `userId`: senza quel filtro toccherebbe i dati di tutti, e la
 * giustificazione cadrebbe.
 *
 * Il limite di cinque al minuto non è contro un attacco: è contro il doppio
 * clic di chi non vede succedere niente perché la risposta arriva a giro
 * finito. Il single-flight di `runner.ts` fa il resto, restituendo al secondo
 * lo stesso risultato del primo.
 */

const MANUAL_RATE_LIMIT = {
  rateLimit: { max: 5, timeWindow: '1 minute' },
} as const;

const jobParamsSchema = z.strictObject({ name: z.enum(JOB_NAMES) });

/**
 * Il `fetcher` dei cambi arriva da fuori.
 *
 * In produzione è `undefined` e vale quello vero. Esiste come parametro perché
 * il giro giornaliero comincia chiamando la BCE, e `jobs.test.ts` — che il giro
 * lo lancia per davvero — uscirebbe in rete: fallirebbe in aereo, in CI dietro
 * un proxy e il giorno in cui Frankfurter è giù, cioè per ragioni che non hanno
 * niente a che vedere con ciò che prova. È la stessa ragione per cui il mailer
 * è un plugin sostituibile.
 */
export function registerJobRoutes(app: FastifyInstance, env: Env, fetcher?: Fetcher): void {
  app.post(
    '/jobs/:name/run',
    { preHandler: app.authenticate, config: MANUAL_RATE_LIMIT },
    async (request, reply) => {
      const user = requireUser(request);
      const { name } = parseBody(jobParamsSchema, request.params);

      // La risposta arriva a giro finito, non subito. Un 202 con un
      // identificativo da interrogare sarebbe la forma giusta per un lavoro
      // lungo, ma richiederebbe una tabella delle esecuzioni per rispondere
      // «com'è andata» — cioè il registro che tutta la fase è costruita per
      // non avere. Il giro dura due secondi su dati veri.
      const result = await runJob(
        name,
        { ...jobContext(app, env, name), fetcher },
        {
          userId: user.id,
        },
      );

      return reply.send(result);
    },
  );
}
