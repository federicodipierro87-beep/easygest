import { randomUUID } from 'node:crypto';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * Le due rotte delle impostazioni.
 *
 * La normalizzazione degli anticipi è provata a fondo in
 * `packages/shared/src/settings.test.ts`, dove non serve un database. Qui resta
 * ciò che si può vedere solo attraversando l'API: che la riga torni
 * normalizzata al chiamante, che un campo non previsto sia un errore e non un
 * silenzio, e che l'utente senza impostazioni si autoripari invece di dare 500
 * proprio nella pagina in cui si va a sistemare le cose.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

let app: FastifyInstance;
let alice: { id: string; auth: { authorization: string } };
/** Creato senza riga di impostazioni, di proposito. */
let orfano: { id: string; auth: { authorization: string } };

async function createUser(
  withSettings: boolean,
): Promise<{ id: string; auth: { authorization: string } }> {
  const user = await app.prisma.user.create({
    data: {
      email: `impostazioni-${randomUUID()}@easygest.test`,
      displayName: 'Utente di prova',
      passwordHash: 'non-usato',
      ...(withSettings ? { settings: { create: {} } } : {}),
    },
    select: { id: true },
  });
  return {
    id: user.id,
    auth: { authorization: `Bearer ${await signAccessToken(user.id, env)}` },
  };
}

interface SettingsBody {
  baseCurrency: string;
  timezone: string;
  reminderDaysBefore: number[];
  cancellationReminderDaysBefore: number[];
  digestEnabled: boolean;
  digestDayOfWeek: number;
  taxRegime: string;
}

interface ErrorBody {
  error: { code: string; details?: unknown };
}

/** Annotato perché `inject` è sovraccaricata, come negli altri file. */
async function patch(
  who: typeof alice,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return await app.inject({ method: 'PATCH', url: '/settings', headers: who.auth, payload: body });
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  alice = await createUser(true);
  orfano = await createUser(false);
});

afterEach(async () => {
  await app.prisma.settings.updateMany({
    where: { userId: alice.id },
    data: {
      timezone: 'Europe/Rome',
      reminderDaysBefore: [30, 7, 1],
      cancellationReminderDaysBefore: [60, 30, 15],
      digestEnabled: true,
      digestDayOfWeek: 1,
    },
  });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, orfano.id] } } });
  await app.close();
});

it('non risponde a chi non ha una sessione', async () => {
  const response = await app.inject({ method: 'GET', url: '/settings' });
  expect(response.statusCode).toBe(401);
});

it('restituisce tutta la riga, non solo i campi degli avvisi', async () => {
  // Alla Fase 6 servirà il blocco fiscale intero: aggiungerlo dopo vorrebbe
  // dire cambiare la forma di una risposta già in uso.
  const response = await app.inject({ method: 'GET', url: '/settings', headers: alice.auth });
  const body = response.json<SettingsBody>();

  expect(response.statusCode).toBe(200);
  expect(body.taxRegime).toBe('FORFETTARIO');
  expect(body.baseCurrency).toBe('EUR');
  expect(body.reminderDaysBefore).toEqual([30, 7, 1]);
});

it('restituisce gli anticipi normalizzati, non quelli digitati', async () => {
  // `[7, 30, 7]` e `[30, 7]` sono la stessa configurazione: salvarle diverse
  // produrrebbe due insiemi di chiavi di deduplica per gli stessi avvisi.
  const response = await patch(alice, { reminderDaysBefore: [7, 30, 7] });

  expect(response.statusCode).toBe(200);
  expect(response.json<SettingsBody>().reminderDaysBefore).toEqual([30, 7]);
});

it('accetta la lista vuota, che \u00e8 il modo di spegnere un promemoria', async () => {
  const response = await patch(alice, { reminderDaysBefore: [] });

  expect(response.statusCode).toBe(200);
  expect(response.json<SettingsBody>().reminderDaysBefore).toEqual([]);
});

it('rifiuta un campo che non esiste invece di ignorarlo', async () => {
  // `digestDay` invece di `digestDayOfWeek` verrebbe scartato in silenzio da
  // uno `z.object`, e l'utente vedrebbe un salvataggio riuscito che non ha
  // salvato niente.
  const response = await patch(alice, { digestDay: 3 });

  expect(response.statusCode).toBe(400);
  expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
});

it('non lascia cambiare la valuta base', async () => {
  // Il cambio è congelato sulle occorrenze: cambiarla non riconvertirebbe lo
  // storico, lo renderebbe incomparabile senza che nessun errore lo segnali.
  const response = await patch(alice, { baseCurrency: 'USD' });
  expect(response.statusCode).toBe(400);
});

it('rifiuta un fuso che non esiste e un giorno fuori dalla settimana', async () => {
  expect((await patch(alice, { timezone: 'Europe/Atlantide' })).statusCode).toBe(400);
  expect((await patch(alice, { digestDayOfWeek: 8 })).statusCode).toBe(400);
  expect((await patch(alice, { digestDayOfWeek: 0 })).statusCode).toBe(400);

  const ok = await patch(alice, { timezone: 'UTC', digestDayOfWeek: 3 });
  expect(ok.statusCode).toBe(200);
  expect(ok.json<SettingsBody>().timezone).toBe('UTC');
  expect(ok.json<SettingsBody>().digestDayOfWeek).toBe(3);
});

it('crea la riga mancante invece di dare 500', async () => {
  // Un utente senza impostazioni troverebbe un errore proprio nella pagina in
  // cui si va a sistemare le cose.
  const response = await app.inject({ method: 'GET', url: '/settings', headers: orfano.auth });

  expect(response.statusCode).toBe(200);
  expect(response.json<SettingsBody>().timezone).toBe('Europe/Rome');
  expect(await app.prisma.settings.count({ where: { userId: orfano.id } })).toBe(1);
});
