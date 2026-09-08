import type { FastifyInstance } from 'fastify';

/**
 * Liveness probe.
 *
 * Risponde se il processo è vivo e nient'altro: non tocca il database, così
 * Railway non riavvia l'API per un problema momentaneo di Postgres, che è un
 * modo eccellente per trasformare un disservizio breve in uno lungo.
 */
function registerLiveness(app: FastifyInstance): void {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              uptimeSeconds: { type: 'number' },
              timestamp: { type: 'string' },
            },
            required: ['status', 'uptimeSeconds', 'timestamp'],
          },
        },
      },
    },
    () => ({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Riduce a una riga leggibile l'errore di un controllo.
 *
 * Serve una funzione apposta perché un errore di Prisma si riduce male da sé:
 * con il database spento `message` vale «Invalid `prisma.$queryRaw()`
 * invocation:» e nient'altro, mentre la causa — `ECONNREFUSED` — sta in `code`.
 * Il codice quindi viene per primo: questa rotta si legge quando qualcosa è già
 * rotto, ed è il momento peggiore per scoprire che non dice niente.
 */
function describeCheckFailure(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  // I messaggi di Prisma sono multilinea e per lo più vuoti: qui interessa che
  // stiano su una riga sola, accanto al codice.
  const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : '';

  if (code !== '' && message !== '') return `${code}: ${message}`;
  if (code !== '') return code;
  if (message !== '') return message;
  return 'errore sconosciuto';
}

/**
 * Readiness probe.
 *
 * Qui le dipendenze si interrogano davvero, ed è la ragione per cui sta su una
 * rotta separata da `/health`: risponde a «sono in grado di servire una
 * richiesta?», non a «sono vivo?». Sono domande diverse e chi le pone reagisce
 * in modo opposto — a un fallimento della prima si riavvia il processo, a un
 * fallimento della seconda ci si limita a toglierlo dal bilanciamento.
 *
 * Risponde 503 quando qualcosa non risponde, così il controllo si automatizza
 * guardando solo lo stato HTTP.
 */
function registerReadiness(app: FastifyInstance): void {
  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const startedAt = process.hrtime.bigint();
    let databaseOk = false;
    let databaseError: string | undefined;

    try {
      // `SELECT 1` e non un conteggio su una tabella vera: interessa sapere se
      // la connessione risponde, non quanto è grande il database.
      await app.prisma.$queryRaw`SELECT 1`;
      databaseOk = true;
    } catch (error) {
      databaseError = describeCheckFailure(error);
      app.log.error({ err: error }, 'Readiness: database non raggiungibile');
    }

    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    return reply.status(databaseOk ? 200 : 503).send({
      status: databaseOk ? 'ready' : 'degraded',
      checks: {
        database: {
          ok: databaseOk,
          latencyMs: Math.round(latencyMs * 100) / 100,
          // Il messaggio dell'errore esce solo quando c'è: è una rotta pensata
          // per essere letta da un umano in un momento di panico.
          ...(databaseError === undefined ? {} : { error: databaseError }),
        },
      },
      timestamp: new Date().toISOString(),
    });
  });
}

export function registerHealthRoutes(app: FastifyInstance): void {
  registerLiveness(app);
  registerReadiness(app);
}
