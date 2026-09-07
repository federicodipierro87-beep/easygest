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
    // Il limite severo sul login arriverà come override per singola rotta:
    // questo è solo il tetto generale contro gli abusi accidentali.
  });
}
