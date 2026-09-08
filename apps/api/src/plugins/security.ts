import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

import type { Env } from '../config/env';

export async function registerSecurity(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(helmet, {
    // L'API restituisce solo JSON e non serve pagine: la CSP di default di
    // helmet è inutile qui e complicherebbe soltanto le risposte di errore.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    // Il refresh token viaggia in un cookie httpOnly, quindi il browser deve
    // poter inviare credenziali. Con `credentials: true` l'origine wildcard è
    // vietata dalla specifica: per questo CORS_ORIGINS è una lista esplicita.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 86_400,
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Il limite severo sul login è un override per singola rotta, in
    // `routes/auth.ts`: questo è solo il tetto generale contro gli abusi
    // accidentali.

    /**
     * Il messaggio predefinito del plugin è in inglese e non porta un `code`:
     * un 429 arrivava al frontend come `INTERNAL_ERROR`, indistinguibile da un
     * guasto del server proprio nel caso in cui la risposta giusta è «aspetta
     * e riprova».
     *
     * Quello che si costruisce qui è un errore da *lanciare*, non il corpo
     * della risposta: il plugin fa `throw errorResponseBuilder(...)`, quindi
     * restituire l'involucro `{ error: ... }` significherebbe lanciare un
     * oggetto qualunque, che l'error handler non riconosce come `Error` e
     * degrada a 500. L'involucro lo costruisce già lui, letti `statusCode` e
     * `code` da qui.
     */
    errorResponseBuilder: (_request, context) => {
      const error = new Error(`Troppi tentativi. Riprova fra ${context.after}.`) as Error & {
        statusCode: number;
        code: string;
      };
      // `context.statusCode` è 429, ma diventa 403 se un giorno si attiverà
      // l'opzione `ban`: copiarlo invece di scrivere 429 evita di dover
      // ricordarsene in quel momento.
      error.statusCode = context.statusCode;
      error.code = 'RATE_LIMITED';
      return error;
    },
  });
}
