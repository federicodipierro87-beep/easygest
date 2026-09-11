import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import type { Env } from './config/env';
import { mailerPlugin } from './mail';
import { authPlugin } from './plugins/auth';
import { prismaPlugin } from './plugins/prisma';
import { registerSecurity } from './plugins/security';
import { registerAuthRoutes } from './routes/auth';
import { registerCategoryRoutes } from './routes/categories';
import { registerClientRoutes } from './routes/clients';
import { registerExpenseRoutes } from './routes/expenses';
import { registerHealthRoutes } from './routes/health';
import { registerJobRoutes } from './routes/jobs';
import { registerNotificationRoutes } from './routes/notifications';
import { registerOccurrenceRoutes } from './routes/occurrences';
import { registerPaymentMethodRoutes } from './routes/payment-methods';
import { registerSettingsRoutes } from './routes/settings';
import { registerVendorRoutes } from './routes/vendors';
import type { Fetcher } from './services/frankfurter';

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

/**
 * Le dipendenze esterne che un test può sostituire.
 *
 * Ce n'è una sola, e non è una comodità: `POST /jobs/:name/run` lancia un giro
 * vero, e il giro comincia chiamando la BCE. Il mailer risolve lo stesso
 * problema da plugin, perché serve anche altrove; il `fetcher` dei cambi serve
 * solo qui, e un parametro costa meno di un secondo plugin.
 */
export interface AppOverrides {
  fxFetcher?: Fetcher;
}

export async function buildApp(env: Env, overrides: AppOverrides = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(env),
    genReqId: () => randomUUID(),
    // Railway termina TLS davanti al processo: senza questo ogni richiesta
    // risulterebbe provenire dal proxy e il rate limiting sarebbe globale
    // invece che per client.
    trustProxy: env.NODE_ENV === 'production',
    bodyLimit: 1_048_576, // 1 MiB: i file non passano da qui, vanno diretti su R2
  });

  /**
   * Un POST senza corpo deve passare, qualunque `Content-Type` dichiari.
   *
   * `/auth/refresh` e `/auth/logout` non ricevono niente: leggono il cookie. Il
   * browser però manda `fetch(url, { method: 'POST' })` senza `Content-Type`, e
   * la rewrite di Netlify ne aggiunge uno per conto suo prima di inoltrare a
   * Railway. Fastify non ha un parser per quel tipo e risponde 415, quindi la
   * sessione non si rinnoverebbe mai: chiamando l'API direttamente lo stesso
   * identico comando risponde 401, il che rende il difetto invisibile in
   * sviluppo e visibile solo in produzione.
   *
   * Il parser accetta il corpo vuoto e rifiuta tutto il resto: una richiesta
   * senza contenuto non ha contenuto da interpretare male, mentre un corpo vero
   * in un formato che non sappiamo leggere resta un 415 — ora però con un
   * codice nostro invece di quello interno di Fastify.
   */
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => {
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    const error = new Error(
      `Content-Type non supportato: ${request.headers['content-type'] ?? 'assente'}`,
    ) as Error & { statusCode: number; code: string };
    error.statusCode = 415;
    error.code = 'UNSUPPORTED_MEDIA_TYPE';
    done(error);
  });

  await registerSecurity(app, env);
  await app.register(prismaPlugin, env);
  await app.register(authPlugin, env);
  await app.register(mailerPlugin, env);
  registerHealthRoutes(app);
  registerAuthRoutes(app, env);
  registerClientRoutes(app);
  registerVendorRoutes(app);
  registerCategoryRoutes(app);
  registerPaymentMethodRoutes(app);
  registerExpenseRoutes(app);
  registerOccurrenceRoutes(app);
  registerNotificationRoutes(app);
  registerSettingsRoutes(app);
  registerJobRoutes(app, env, overrides.fxFetcher);

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
