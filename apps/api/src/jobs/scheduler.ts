import { Cron } from 'croner';
import type { FastifyInstance } from 'fastify';

import type { Env } from '../config/env';
import { jobContext, runJob } from './runner';
import type { JobName } from './types';

/**
 * La pianificazione, dentro il processo dell'API.
 *
 * Non un secondo servizio su Railway: un container acceso ventiquattr'ore per
 * lavorare due minuti al giorno non compra nulla a un'applicazione con un
 * utente, e l'unico argomento serio a favore — log separati — si ottiene con
 * `app.log.child({ job })`, che è ciò che fa `jobContext`.
 *
 * La scelta ha una condizione, ed è scritta qui perché è l'unica che la
 * invaliderebbe: il servizio non deve avere «App Sleeping» attivo. Un processo
 * addormentato alle 07:00 non gira, e non se ne accorgerebbe nessuno finché
 * qualcuno non nota che le email hanno smesso di arrivare.
 *
 * **Lo scheduler si avvia in `index.ts`, non in `buildApp`.** È la decisione
 * più importante del modulo: `buildApp` è chiamata da una ventina di test di
 * integrazione, e un cron che partisse lì dentro marcherebbe `PAID` occorrenze
 * di prova mentre un test le conta. Un flag non sarebbe una garanzia, perché
 * `vitest.setup.ts` legge `apps/api/.env`; con lo scheduler in `index.ts` la
 * garanzia è strutturale — i test non eseguono mai quel file.
 */

/**
 * Gli orari, costanti e non variabili d'ambiente.
 *
 * Il bisogno vero — «verifico adesso invece di aspettare domani» — lo copre
 * l'esecuzione manuale, che è anche l'unico modo in cui qualcuno vorrebbe
 * davvero cambiare un orario: una volta sola, subito.
 */
const SCHEDULES: Record<JobName, { cron: string; why: string }> = {
  /** Le 07:00: abbastanza presto da trovarsela letta prima di iniziare. */
  daily: { cron: '0 7 * * *', why: 'giro completo' },
  /**
   * Le 16:30 nei giorni lavorativi: la BCE pubblica verso le 16:00 CET, e
   * aspettare il mattino dopo terrebbe le occorrenze di oggi ferme un giorno.
   */
  fx: { cron: '30 16 * * 1-5', why: 'solo i cambi' },
};

export interface Scheduler {
  /** Ferma la pianificazione e attende ciò che è già partito. */
  stop(): Promise<void>;
}

/** Quanto si aspetta un giro in volo prima di chiudere comunque. */
const STOP_TIMEOUT_MS = 20_000;

/**
 * Lancia un giro e lo tiene contato finché non finisce.
 *
 * Un giro che esplode non deve buttare giù il processo: `croner` non ha un
 * gestore d'errore globale, e un `unhandledRejection` in produzione è un
 * riavvio — cioè il modo più rumoroso di reagire a una spesa in corone senza
 * tasso. L'insieme `running` serve all'arresto, che aspetta ciò che è in volo.
 */
function launch(
  app: FastifyInstance,
  env: Env,
  name: JobName,
  running: Set<Promise<void>>,
  what: string,
): Promise<void> {
  const promise = runJob(name, jobContext(app, env, name))
    .then(() => undefined)
    .catch((error: unknown) => {
      app.log.error({ err: error, job: name }, what);
    });
  running.add(promise);
  void promise.finally(() => running.delete(promise));
  return promise;
}

function startJob(
  app: FastifyInstance,
  env: Env,
  name: JobName,
  running: Set<Promise<void>>,
): Cron {
  return new Cron(
    SCHEDULES[name].cron,
    {
      timezone: env.CRON_TIMEZONE,
      // Il primo dei tre livelli contro la sovrapposizione: salta un'esecuzione
      // se la precedente non è finita. Copre solo la pianificazione, e il
      // single-flight di `runner.ts` copre il resto.
      protect: true,
    },
    () => launch(app, env, name, running, 'Giro fallito'),
  );
}

/**
 * Il giro di recupero all'avvio.
 *
 * Si esegue a ogni avvio, senza chiedersi se sia già stato fatto oggi: tutta la
 * pipeline è idempotente per costruzione, quindi tre deploy in un pomeriggio
 * producono tre giri e zero effetti. Un registro delle esecuzioni servirebbe
 * solo a sostituire una garanzia strutturale con una scritta.
 *
 * Il ritardo serve a non far competere il primo giro con l'healthcheck
 * `/ready`, che decide se promuovere la release: `unref()` perché venti secondi
 * di attesa non devono tenere vivo un processo che sta già uscendo.
 */
function scheduleCatchup(app: FastifyInstance, env: Env, running: Set<Promise<void>>): void {
  const timer = setTimeout(() => {
    void launch(app, env, 'daily', running, 'Giro di recupero fallito');
  }, env.CRON_CATCHUP_DELAY_MS);
  timer.unref();
}

/**
 * Avvia la pianificazione, o dice che non l'ha fatto.
 *
 * La riga di log con `nextRun` è l'unico modo di accorgersi dai log di Railway
 * che `CRON_ENABLED` è rimasta a `false` — che è il difetto più probabile di
 * tutta la fase, perché in locale è `false` di proposito.
 */
export function startScheduler(app: FastifyInstance, env: Env): Scheduler {
  if (!env.CRON_ENABLED) {
    app.log.warn('Lavori pianificati disattivati: CRON_ENABLED non è vera');
    return { stop: () => Promise.resolve() };
  }

  const running = new Set<Promise<void>>();
  const crons = (Object.keys(SCHEDULES) as JobName[]).map((name) => ({
    name,
    cron: startJob(app, env, name, running),
  }));

  app.log.info(
    {
      timezone: env.CRON_TIMEZONE,
      jobs: crons.map(({ name, cron }) => ({
        name,
        cron: SCHEDULES[name].cron,
        nextRun: cron.nextRun()?.toISOString() ?? null,
      })),
    },
    'Lavori pianificati',
  );

  scheduleCatchup(app, env, running);

  return {
    async stop(): Promise<void> {
      for (const { cron } of crons) cron.stop();
      if (running.size === 0) return;

      app.log.info({ inFlight: running.size }, 'Attesa dei giri in corso');
      // Il tetto esiste perché l'alternativa è peggiore: Railway uccide il
      // processo dopo il suo timeout, e un giro troncato lì è indistinguibile
      // da uno troncato qui — con la differenza che qui resta scritto nei log.
      await Promise.race([
        Promise.allSettled([...running]),
        new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS).unref()),
      ]);
    },
  };
}
