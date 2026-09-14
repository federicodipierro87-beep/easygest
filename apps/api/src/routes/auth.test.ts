import { randomUUID } from 'node:crypto';

import { hashSync as bcryptHashSync } from '@node-rs/bcrypt';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * `PATCH /auth/me`, la prima rotta di autenticazione provata da fuori.
 *
 * Fin qui l'autenticazione era coperta solo a livello di servizio, in
 * `auth/service.test.ts`: là si verifica cosa succede al database, qui cosa
 * attraversa davvero l'API. Restano quindi le tre cose che il servizio non può
 * mostrare — che senza token non si entri, che un corpo malformato sia un 400 e
 * non un silenzio, e che la risposta riporti l'email **normalizzata**, che è
 * l'intera ragione per cui questa rotta non risponde 204.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

/** Costo minimo di bcrypt: qui interessa il giro completo, non la lentezza. */
const TEST_BCRYPT_COST = 4;
const PASSWORD = 'password-di-prova-1';

let app: FastifyInstance;
let alice: { id: string; auth: { authorization: string } };

async function createUser(): Promise<{ id: string; auth: { authorization: string } }> {
  const user = await app.prisma.user.create({
    data: {
      email: `profilo-${randomUUID()}@easygest.test`,
      displayName: 'Utente di prova',
      passwordHash: bcryptHashSync(PASSWORD, TEST_BCRYPT_COST),
      settings: { create: {} },
    },
    select: { id: true },
  });
  return {
    id: user.id,
    auth: { authorization: `Bearer ${await signAccessToken(user.id, env)}` },
  };
}

interface UserBody {
  id: string;
  email: string;
  displayName: string;
}

interface ErrorBody {
  error: { code: string; details?: unknown };
}

/** Annotato perché `inject` è sovraccaricata, come negli altri file. */
async function patch(body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return await app.inject({ method: 'PATCH', url: '/auth/me', headers: alice.auth, payload: body });
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  alice = await createUser();
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: alice.id } });
  await app.close();
});

it('non risponde a chi non ha una sessione', async () => {
  const response = await app.inject({
    method: 'PATCH',
    url: '/auth/me',
    payload: { displayName: 'Chiunque' },
  });
  expect(response.statusCode).toBe(401);
});

it('rifiuta un patch che non cambia niente', async () => {
  // Un 200 su un corpo vuoto direbbe «salvato» a chi non ha toccato nulla.
  const response = await patch({});

  expect(response.statusCode).toBe(400);
  expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
});

it('rifiuta una chiave che non esiste invece di ignorarla', async () => {
  const response = await patch({ displayName: 'Federico', ruolo: 'admin' });

  expect(response.statusCode).toBe(400);
  expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
});

it('restituisce la riga aggiornata, con l’email in minuscolo', async () => {
  // La normalizzazione è la ragione per cui questa rotta non risponde 204: chi
  // scrive `Mario@Gmail.com` deve rileggere ciò che è stato davvero salvato.
  const indirizzo = `Profilo-${randomUUID()}@Easygest.TEST`;
  const response = await patch({
    displayName: '  Federico  ',
    email: indirizzo,
    currentPassword: PASSWORD,
  });
  const body = response.json<UserBody>();

  expect(response.statusCode).toBe(200);
  expect(body.id).toBe(alice.id);
  expect(body.displayName).toBe('Federico');
  expect(body.email).toBe(indirizzo.toLowerCase());
});
