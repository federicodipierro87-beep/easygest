import { buildApp } from './app';
import { EnvValidationError, loadEnv } from './config/env';
import { startScheduler } from './jobs/scheduler';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  /**
   * La pianificazione parte qui e non in `buildApp`.
   *
   * `buildApp` è chiamata da una ventina di test di integrazione: un cron che
   * partisse lì dentro sarebbe una condizione di corsa contro la suite, e
   * marcherebbe `PAID` occorrenze di prova mentre un test le conta. Un flag non
   * sarebbe una garanzia, perché `vitest.setup.ts` legge `apps/api/.env`; da
   * qui la garanzia è strutturale, perché i test non eseguono mai questo file.
   */
  const scheduler = startScheduler(app, env);

  /**
   * Railway invia SIGTERM e attende prima di uccidere il processo: chiudere
   * Fastify qui lascia terminare le richieste in corso invece di troncarle a
   * metà, cosa che con una transazione aperta lascerebbe dati incoerenti.
   *
   * Lo scheduler si ferma **prima** del server. L'ordine inverso lascerebbe un
   * giro in volo con il client Prisma disconnesso a metà — e a metà di cosa,
   * con delle email in corso, è la domanda peggiore da doversi fare leggendo i
   * log il giorno dopo.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Arresto in corso');
    scheduler
      .stop()
      .then(() => app.close())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'Arresto non pulito');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    // Prima che il logger esista: qui `console.error` è l'unico canale.
    console.error(error.message);
    process.exit(78); // EX_CONFIG
  }
  console.error(error);
  process.exit(1);
});
