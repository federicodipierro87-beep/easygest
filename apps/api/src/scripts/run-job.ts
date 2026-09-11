import { JOB_NAMES, isJobName } from '@easygest/shared';

import { buildApp } from '../app';
import { loadEnv } from '../config/env';
import { jobContext, runJob } from '../jobs/runner';

/**
 * Esegue un lavoro pianificato, a mano.
 *
 * `npm run jobs:run -w @easygest/api -- daily`, oppure `-- fx`.
 *
 * Esiste accanto a `POST /jobs/:name/run` e non al suo posto, perché copre il
 * caso in cui la rotta non serve a niente: il server non parte, oppure si vuole
 * verificare la pipeline prima di esporla. È anche il modo in cui si prova il
 * giro in locale — con `MAIL_TRANSPORT` a `log` le email finiscono nei log
 * invece di partire davvero.
 *
 * Passa da `buildApp` e non da `createPrismaClient` come fa `sync-fx.ts`: un
 * giro completo ha bisogno anche del mailer e del logger, che sono già montati
 * lì con la configurazione vera. Lo scheduler resta spento, perché si avvia in
 * `index.ts`.
 */
async function main(): Promise<void> {
  const requested = process.argv[2];
  if (requested === undefined || !isJobName(requested)) {
    throw new Error(
      `Lavoro sconosciuto: ${requested ?? 'nessuno'}. Attesi: ${JOB_NAMES.join(', ')}.`,
    );
  }

  const env = loadEnv();
  const app = await buildApp(env);
  await app.ready();

  try {
    const result = await runJob(requested, jobContext(app, env, requested));
    console.log(`${result.name} in ${String(result.durationMs)} ms`);
    for (const [label, value] of Object.entries(result.counters)) {
      console.log(`  ${label}: ${String(value)}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
