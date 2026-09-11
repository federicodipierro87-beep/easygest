import type { JobName, JobResult } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { Env } from '../config/env';
import { type JobOptions, runDailyJob, runFxJob } from './daily';
import type { JobContext } from './types';

/**
 * L'unica porta da cui si entra in un lavoro.
 *
 * Le chiamate arrivano da tre parti — la pianificazione, il pulsante «Esegui
 * adesso» e lo script `jobs:run` — e due di queste possono capitare nello
 * stesso momento: si preme il pulsante alle 07:00 esatte, oppure lo si preme
 * due volte perché la prima risposta tarda. Due giri contemporanei sullo stesso
 * utente non corrompono niente (la deduplica è nel database), ma sprecano
 * query e scrivono log illeggibili.
 *
 * La protezione è a tre livelli, di cui due implementati:
 *
 * 1. `protect: true` di croner, che salta un'esecuzione se la precedente è
 *    ancora in corso. Copre solo la pianificazione.
 * 2. Il single-flight qui sotto, che copre anche le chiamate manuali.
 * 3. Un `pg_try_advisory_lock`, che servirebbe con più di una replica e non
 *    c'è: con due processi, ognuno ha la propria `Map` e non sa dell'altro.
 *    Va scritto perché è il punto esatto in cui il codice attuale smetterebbe
 *    di bastare, e quel punto è una riga nella configurazione di Railway.
 */

/**
 * I giri in corso, uno per nome.
 *
 * Chi arriva secondo riceve **il risultato del primo** invece di un errore,
 * come già fa `refreshInFlight` in `apps/web/src/lib/session.ts`. Un 409
 * sarebbe più esplicito e meno utile: chi ha premuto il pulsante vuole i
 * contatori del giro, e i contatori del giro che sta girando sono la risposta
 * giusta alla sua domanda.
 */
const inFlight = new Map<string, Promise<JobResult>>();

/** Il nome più il destinatario: due utenti diversi non si accodano a vicenda. */
function flightKey(name: JobName, options: JobOptions): string {
  return `${name}:${options.userId ?? 'tutti'}`;
}

function execute(name: JobName, context: JobContext, options: JobOptions): Promise<JobResult> {
  switch (name) {
    case 'daily':
      return runDailyJob(context, options);
    case 'fx':
      return runFxJob(context);
  }
}

export async function runJob(
  name: JobName,
  context: JobContext,
  options: JobOptions = {},
): Promise<JobResult> {
  const key = flightKey(name, options);

  const running = inFlight.get(key);
  if (running !== undefined) {
    context.log.info({ job: name }, 'Giro già in corso, ci si accoda');
    return running;
  }

  const started = (async () => {
    try {
      return await execute(name, context, options);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, started);

  const result = await started;
  context.log.info({ job: name, ...result.counters, durationMs: result.durationMs }, 'Giro finito');
  return result;
}

/**
 * Il contesto di un giro, dedotto dall'applicazione.
 *
 * `log` è un figlio con `{ job }` addosso: è ciò che sostituisce i log separati
 * che si sarebbero avuti con un secondo servizio su Railway, ed è l'unica cosa
 * che quel secondo servizio avrebbe davvero comprato.
 */
export function jobContext(
  app: FastifyInstance,
  env: Env,
  name: JobName,
  now = new Date(),
): JobContext {
  return {
    prisma: app.prisma,
    mailer: app.mailer,
    log: app.log.child({ job: name }),
    now,
    baseUrl: env.APP_BASE_URL,
    notificationRetentionDays: env.NOTIFICATION_RETENTION_DAYS,
  };
}
