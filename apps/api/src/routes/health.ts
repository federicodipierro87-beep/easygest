import type { FastifyInstance } from 'fastify';

/**
 * Liveness probe.
 *
 * Risponde se il processo è vivo e nient'altro: non tocca il database, così
 * Railway non riavvia l'API per un problema momentaneo di Postgres, che è un
 * modo eccellente per trasformare un disservizio breve in uno lungo.
 *
 * La readiness probe, che invece verifica le dipendenze esterne, arriva
 * insieme a Prisma e allo storage.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
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
