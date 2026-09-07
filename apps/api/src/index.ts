import { buildApp } from './app';
import { EnvValidationError, loadEnv } from './config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  /**
   * Railway invia SIGTERM e attende prima di uccidere il processo: chiudere
   * Fastify qui lascia terminare le richieste in corso invece di troncarle a
   * metà, cosa che con una transazione aperta lascerebbe dati incoerenti.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Arresto in corso');
    app
      .close()
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
