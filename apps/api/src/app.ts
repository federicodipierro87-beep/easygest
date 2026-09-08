import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import type { Env } from './config/env';
import { authPlugin } from './plugins/auth';
import { prismaPlugin } from './plugins/prisma';
import { registerSecurity } from './plugins/security';
import { registerAuthRoutes } from './routes/auth';
import { registerHealthRoutes } from './routes/health';

/**
 * Formato unico delle risposte di errore.
 *
 * Il frontend deve poter distinguere un errore di validazione da uno di
 * autorizzazione senza indovinare dal testo, quindi ogni errore esce sempre
 * con questa forma.
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

function buildLoggerOptions(env: Env) {
  return {
    level: env.LOG_LEVEL,
    // In sviluppo il JSON di pino è illeggibile a occhio; in produzione è
    // esattamente quello che vuoi, perché Railway lo indicizza.
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'req.body.password',
        'req.body.currentPassword',
        'req.body.newPassword',
      ],
      censor: '[redacted]',
    },
  };
}

/**
 * Riduce un errore a qualcosa di rappresentabile.
 *
 * Fastify tipa l'errore come `unknown` perché in JavaScript si può lanciare
 * qualsiasi valore, non solo un `Error`: una libreria che facesse
 * `throw 'boom'` farebbe esplodere l'error handler stesso, trasformando un 400
 * in una connessione chiusa senza risposta.
 */
function describeError(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof Error) {
    const annotated = error as Error & {
      statusCode?: number;
      code?: string;
      details?: unknown;
    };
    return {
      statusCode: annotated.statusCode ?? 500,
      code: annotated.code ?? 'INTERNAL_ERROR',
      message: error.message,
      details: annotated.details,
    };
  }
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Errore sconosciuto' };
}

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(env),
    genReqId: () => randomUUID(),
    // Railway termina TLS davanti al processo: senza questo ogni richiesta
    // risulterebbe provenire dal proxy e il rate limiting sarebbe globale
    // invece che per client.
    trustProxy: env.NODE_ENV === 'production',
    bodyLimit: 1_048_576, // 1 MiB: i file non passano da qui, vanno diretti su R2
  });

  await registerSecurity(app, env);
  await app.register(prismaPlugin, env);
  await app.register(authPlugin, env);
  registerHealthRoutes(app);
  registerAuthRoutes(app, env);

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorResponse = {
      error: {
        code: 'NOT_FOUND',
        message: `Rotta ${request.method} ${request.url} inesistente`,
        requestId: request.id,
      },
    };
    return reply.status(404).send(body);
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const { statusCode, code, message, details } = describeError(error);

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Richiesta fallita');
    } else {
      request.log.warn({ err: error, statusCode }, 'Richiesta rifiutata');
    }

    const body: ErrorResponse = {
      error: {
        code,
        // Il messaggio di un 500 può contenere dettagli di infrastruttura:
        // resta nei log, non nella risposta.
        message: statusCode >= 500 ? 'Errore interno del server' : message,
        requestId: request.id,
        // Per la stessa ragione i dettagli escono solo sotto il 500: sono utili
        // a evidenziare i campi sbagliati di un form, non a raccontare a un
        // estraneo com'è fatto l'interno del server.
        ...(details === undefined || statusCode >= 500 ? {} : { details }),
      },
    };
    return reply.status(statusCode).send(body);
  });

  return app;
}
