import {
  AUTH_ERROR_CODES,
  changePasswordSchema,
  loginSchema,
  registerSchema,
} from '@easygest/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  AuthError,
  type ClientInfo,
  changePassword,
  login,
  logout,
  refresh,
  register,
} from '../auth/service';
import { hashRefreshToken } from '../auth/tokens';
import type { Env } from '../config/env';
import { parseBody } from '../lib/validation';
import {
  clearRefreshCookie,
  readRefreshCookie,
  requireUser,
  setRefreshCookie,
} from '../plugins/auth';

/**
 * Limite severo sul login.
 *
 * Il tetto generale (300/minuto) non serve a niente contro un attacco a
 * dizionario: sono migliaia di tentativi comunque. Qui la finestra è lunga e
 * il numero basso, perché una persona che ricorda la propria password non
 * sbaglia cinque volte in un quarto d'ora.
 *
 * Vale per IP, con il limite che ne deriva: dietro il proxy l'indirizzo arriva
 * da `X-Forwarded-For`, che chi attacca può manipolare. Rallenta il tentativo
 * ingenuo, non quello determinato — la difesa vera resta bcrypt a costo 12.
 */
const LOGIN_RATE_LIMIT = {
  rateLimit: { max: 5, timeWindow: '15 minutes' },
} as const;

function clientInfo(request: FastifyRequest): ClientInfo {
  return {
    // Troncato: è un'intestazione controllata dal client, e senza limite
    // finirebbe nel database esattamente com'è stata inviata.
    userAgent: request.headers['user-agent']?.slice(0, 300),
    ipAddress: request.ip,
  };
}

export function registerAuthRoutes(app: FastifyInstance, env: Env): void {
  const deps = { prisma: app.prisma, env };

  app.post('/auth/login', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    const input = parseBody(loginSchema, request.body);
    const { session, refreshToken } = await login(deps, input, clientInfo(request));
    setRefreshCookie(reply, env, refreshToken);
    return reply.send(session);
  });

  app.post('/auth/register', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    const input = parseBody(registerSchema, request.body);
    const { session, refreshToken } = await register(deps, input, clientInfo(request));
    setRefreshCookie(reply, env, refreshToken);
    return reply.status(201).send(session);
  });

  /**
   * Rinnova la sessione.
   *
   * Non è protetta da `authenticate`: si chiama proprio quando l'access token
   * è scaduto. L'unica credenziale è il cookie.
   *
   * Il cookie viene cancellato su ogni fallimento. Se il token non è più
   * valido, tenerlo significherebbe solo che il browser continua a riprovare
   * con qualcosa che non funzionerà mai.
   */
  app.post('/auth/refresh', async (request, reply) => {
    const token = readRefreshCookie(request, env);
    if (token === undefined || token === '') {
      throw new AuthError(401, AUTH_ERROR_CODES.missingRefreshToken, 'Sessione assente');
    }

    try {
      const { session, refreshToken } = await refresh(deps, token, clientInfo(request));
      setRefreshCookie(reply, env, refreshToken);
      return reply.send(session);
    } catch (error) {
      clearRefreshCookie(reply, env);
      throw error;
    }
  });

  /**
   * Chiude la sessione. Risponde 204 anche senza cookie valido: il risultato
   * richiesto — non essere più autenticati — è ottenuto in entrambi i casi, e
   * un errore qui lascerebbe il frontend a chiedersi cosa fare.
   */
  app.post('/auth/logout', async (request, reply) => {
    await logout(deps, readRefreshCookie(request, env));
    clearRefreshCookie(reply, env);
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: app.authenticate }, (request, reply) =>
    reply.send(requireUser(request)),
  );

  app.post('/auth/change-password', { preHandler: app.authenticate }, async (request, reply) => {
    const input = parseBody(changePasswordSchema, request.body);
    const user = requireUser(request);

    // La famiglia della sessione corrente viene risparmiata dalla revoca:
    // chi cambia password non deve ritrovarsi buttato fuori dalla finestra
    // da cui l'ha appena cambiata.
    const token = readRefreshCookie(request, env);
    const current =
      token === undefined || token === ''
        ? null
        : await app.prisma.refreshToken.findUnique({
            where: { tokenHash: hashRefreshToken(token) },
            select: { familyId: true },
          });

    await changePassword(
      deps,
      user.id,
      input.currentPassword,
      input.newPassword,
      current?.familyId,
    );

    return reply.status(204).send();
  });
}
