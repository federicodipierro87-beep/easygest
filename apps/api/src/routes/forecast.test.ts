import { randomUUID } from 'node:crypto';

import type { Forecast } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * La rotta, non la regola.
 *
 * La regola ibrida — cosa si sintetizza e cosa no — è provata a fondo in
 * `services/forecast.test.ts`, dove «oggi» è un parametro e quindi le
 * asserzioni non cambiano risposta a seconda del giorno in cui girano. Qui
 * resta ciò che si vede solo attraversando l'API: che serva una sessione, che
 * un anno scritto male sia un errore invece di dodici mesi vuoti, che
 * `baseCurrency` e il giorno del taglio arrivino nella risposta, e che le
 * righe siano righe — non aggregati.
 *
 * Le date di prova sono relative all'anno vero, perché qui «oggi» è davvero
 * oggi: chiedere un anno fisso significherebbe scrivere un file che dal 2028
 * prova tutt'altro.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

interface TestUser {
  id: string;
  auth: { authorization: string };
}

let app: FastifyInstance;
let alice: TestUser;

/** L'anno prossimo: è tutto futuro, quindi è tutto da sintetizzare. */
const YEAR = new Date().getUTCFullYear() + 1;

async function createUser(): Promise<TestUser> {
  const user = await app.prisma.user.create({
    data: {
      email: `previsioni-${randomUUID()}@easygest.test`,
      displayName: 'Utente di prova',
      passwordHash: 'non-usato',
      settings: { create: {} },
    },
    select: { id: true },
  });
  return {
    id: user.id,
    auth: { authorization: `Bearer ${await signAccessToken(user.id, env)}` },
  };
}

async function get(year: number | string): Promise<Forecast> {
  const response = await app.inject({
    method: 'GET',
    url: `/forecast?year=${String(year)}`,
    headers: alice.auth,
  });
  expect(response.statusCode).toBe(200);
  return response.json<Forecast>();
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  alice = await createUser();
});

afterEach(async () => {
  await app.prisma.expense.deleteMany({ where: { userId: alice.id } });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: alice.id } });
  await app.close();
});

it('non risponde a chi non ha una sessione', async () => {
  const response = await app.inject({ method: 'GET', url: `/forecast?year=${String(YEAR)}` });
  expect(response.statusCode).toBe(401);
});

it('rifiuta un anno che non è un anno', async () => {
  // Dodici mesi vuoti in risposta a `?year=duemila` sembrerebbero una risposta,
  // e chi guarda concluderebbe che l'anno prossimo non ha spese.
  for (const year of ['duemila', '2027,5', '1200', '99999', '']) {
    const response = await app.inject({
      method: 'GET',
      url: `/forecast?year=${year}`,
      headers: alice.auth,
    });
    expect(response.statusCode).toBe(400);
  }
});

it('dichiara l’anno, la valuta e il giorno su cui ha tagliato', async () => {
  // `today` non è ridondante: è il confine fra reale e previsto, e il
  // simulatore nel browser deve tagliare dove ha tagliato il server.
  const forecast = await get(YEAR);

  expect(forecast.year).toBe(YEAR);
  expect(forecast.baseCurrency).toBe('EUR');
  expect(forecast.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(forecast.unconverted).toEqual([]);
});

it('restituisce le righe e non i totali', async () => {
  // Le leve del simulatore lavorano sulla singola spesa: un'API che desse già
  // gli aggregati costringerebbe a un giro di rete a ogni spunta.
  await app.prisma.expense.create({
    data: {
      userId: alice.id,
      name: 'Hosting',
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: 12_200,
      currency: 'EUR',
      recurrenceUnit: 'MONTH',
      recurrenceInterval: 1,
      startDate: new Date(Date.UTC(YEAR, 0, 10)),
      status: 'ACTIVE',
    },
  });

  const forecast = await get(YEAR);

  // Dodici mensilità di un anno interamente futuro, tutte sintetiche.
  expect(forecast.rows).toHaveLength(12);
  expect(forecast.rows.every((row) => row.source === 'previsione')).toBe(true);
  expect(forecast.rows.every((row) => row.occurrenceId === null)).toBe(true);
  expect(forecast.rows[0]?.expenseName).toBe('Hosting');
  expect(forecast.rows[0]?.baseGrossCents).toBe(12_200);
  expect(forecast.rows.map((row) => row.dueDate)).toEqual(
    [...Array(12).keys()].map(
      (index) => `${String(YEAR)}-${String(index + 1).padStart(2, '0')}-10`,
    ),
  );
});
