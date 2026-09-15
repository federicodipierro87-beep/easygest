import { randomUUID } from 'node:crypto';

import { type DashboardSummary, formatIsoDate, todayIn } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * La rotta della dashboard.
 *
 * La classificazione delle quattro sezioni è già provata in
 * `services/agenda.test.ts`, che possiede quella logica: qui resta solo ciò
 * che si vede dalla rotta e da nessun'altra parte — che serva una sessione,
 * che i numeri di Bob non finiscano sulla pagina di Alice, che «oggi» sia il
 * giorno dell'utente e non quello del server, e che i due totali in fondo
 * contino le righe giuste.
 *
 * Gli utenti hanno fuso `UTC` di proposito, tranne quelli del test sui fusi. I
 * confini del mese dipendono da «oggi», e con `Europe/Rome` le prove
 * diventerebbero rosse per un'ora nelle notti di fine mese: un test che
 * fallisce a seconda dell'ora in cui lo lanci non dice se il codice è giusto.
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
let bob: TestUser;
/** Fuso +14: il posto sulla Terra dove la data è più avanti. */
let east: TestUser;
/** Fuso −11: venticinque ore indietro, cioè sempre un altro giorno. */
let west: TestUser;

async function createUser(timezone: string): Promise<TestUser> {
  const user = await app.prisma.user.create({
    data: {
      email: `dashboard-${randomUUID()}@easygest.test`,
      displayName: 'Utente di prova',
      passwordHash: 'non-usato',
      settings: { create: { timezone } },
    },
    select: { id: true },
  });
  return {
    id: user.id,
    auth: { authorization: `Bearer ${await signAccessToken(user.id, env)}` },
  };
}

/** Mezzanotte UTC del giorno `day` del mese in corso, spostato di `months`. */
function inMonth(months: number, day: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, day));
}

interface OccurrenceSeed {
  dueDate: Date;
  status?: 'PLANNED' | 'PAID' | 'SKIPPED' | 'CANCELLED';
  baseGrossCents?: number;
}

async function anExpense(who: TestUser, occurrences: OccurrenceSeed[]): Promise<void> {
  await app.prisma.expense.create({
    data: {
      userId: who.id,
      name: 'Hosting',
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: 12_200,
      currency: 'EUR',
      recurrenceUnit: 'MONTH',
      recurrenceInterval: 1,
      startDate: occurrences[0]?.dueDate ?? inMonth(0, 1),
      status: 'ACTIVE',
      occurrences: {
        create: occurrences.map((seed) => ({
          userId: who.id,
          dueDate: seed.dueDate,
          periodStart: seed.dueDate,
          netCents: 10_000,
          vatRateBp: 2200,
          grossCents: 12_200,
          currency: 'EUR',
          baseGrossCents: seed.baseGrossCents ?? 12_200,
          status: seed.status ?? 'PLANNED',
          paidAt: seed.status === 'PAID' ? seed.dueDate : null,
        })),
      },
    },
  });
}

async function fetchDashboard(who: TestUser): Promise<DashboardSummary> {
  const response = await app.inject({ method: 'GET', url: '/dashboard', headers: who.auth });
  expect(response.statusCode).toBe(200);
  return response.json<DashboardSummary>();
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  alice = await createUser('UTC');
  bob = await createUser('UTC');
  east = await createUser('Pacific/Kiritimati');
  west = await createUser('Pacific/Niue');
});

afterEach(async () => {
  await app.prisma.expense.deleteMany({
    where: { userId: { in: [alice.id, bob.id, east.id, west.id] } },
  });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({
    where: { id: { in: [alice.id, bob.id, east.id, west.id] } },
  });
  await app.close();
});

describe('accesso', () => {
  it('senza sessione risponde 401 e non un riepilogo vuoto', async () => {
    // La differenza conta: un 200 con tutti zeri sembrerebbe un utente nuovo.
    const response = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(response.statusCode).toBe(401);
  });
});

describe('isolamento', () => {
  it('le scadenze di Bob non entrano in nessun numero di Alice', async () => {
    await anExpense(bob, [
      { dueDate: inMonth(0, 2), baseGrossCents: 50_000 },
      { dueDate: inMonth(-2, 2), baseGrossCents: 60_000, status: 'PAID' },
    ]);

    const summary = await fetchDashboard(alice);

    expect(summary.currentMonthCents).toBe(0);
    expect(summary.monthlyAverageCents).toBe(0);
    expect(summary.upcoming.total).toBe(0);
    expect(summary.overdue.total).toBe(0);
    expect(summary.toConfirm.total).toBe(0);
    expect(summary.cancellations.total).toBe(0);
  });
});

describe('«oggi»', () => {
  it('è il giorno dell’utente, non quello del server', async () => {
    // Venticinque ore separano i due fusi: le loro date non coincidono mai, in
    // nessun istante dell'anno. Se la rotta usasse l'orologio del server le
    // due risposte sarebbero identiche.
    const [eastern, western] = await Promise.all([fetchDashboard(east), fetchDashboard(west)]);

    expect(eastern.today).not.toBe(western.today);
    expect(eastern.today).toBe(formatIsoDate(todayIn('Pacific/Kiritimati', new Date())));
    expect(western.today).toBe(formatIsoDate(todayIn('Pacific/Niue', new Date())));
  });

  it('porta con sé la valuta base, perché i totali sono in quella', async () => {
    const summary = await fetchDashboard(alice);
    expect(summary.baseCurrency).toBe('EUR');
  });
});

describe('costo del mese', () => {
  it('conta le previste e lascia fuori saltate e annullate', async () => {
    // Le previste entrano: il mese in corso è fatto in gran parte di scadenze
    // non ancora pagate, e un numero che le ignorasse crescerebbe da solo fino
    // al 31. Le saltate no: sono soldi mai usciti.
    await anExpense(alice, [
      { dueDate: inMonth(0, 1), baseGrossCents: 10_000, status: 'PLANNED' },
      { dueDate: inMonth(0, 2), baseGrossCents: 5_000, status: 'PAID' },
      { dueDate: inMonth(0, 3), baseGrossCents: 900_000, status: 'SKIPPED' },
      { dueDate: inMonth(0, 4), baseGrossCents: 800_000, status: 'CANCELLED' },
    ]);

    const summary = await fetchDashboard(alice);
    expect(summary.currentMonthCents).toBe(15_000);
  });

  it('non tira dentro il mese prossimo né quello scorso', async () => {
    await anExpense(alice, [
      { dueDate: inMonth(-1, 15), baseGrossCents: 70_000 },
      { dueDate: inMonth(0, 15), baseGrossCents: 1_000 },
      { dueDate: inMonth(1, 15), baseGrossCents: 90_000 },
    ]);

    const summary = await fetchDashboard(alice);
    expect(summary.currentMonthCents).toBe(1_000);
  });
});

describe('media mensile', () => {
  it('divide per dodici anche quando i mesi pieni sono uno solo', async () => {
    // Dodicimila su un mese solo fanno mille al mese, non dodicimila: la media
    // serve da metro di paragone del mese in corso, e un denominatore
    // variabile la renderebbe incomparabile con sé stessa.
    await anExpense(alice, [{ dueDate: inMonth(-3, 10), baseGrossCents: 12_000 }]);

    const summary = await fetchDashboard(alice);
    expect(summary.monthlyAverageCents).toBe(1_000);
  });

  it('esclude il mese in corso, che è ancora a metà', async () => {
    await anExpense(alice, [{ dueDate: inMonth(0, 1), baseGrossCents: 120_000 }]);

    const summary = await fetchDashboard(alice);
    expect(summary.currentMonthCents).toBe(120_000);
    expect(summary.monthlyAverageCents).toBe(0);
  });

  it('senza nulla da dividere vale zero, non `null` né `NaN`', async () => {
    // `_sum` su un insieme vuoto è `null` per Postgres, e un `null` che arriva
    // in pagina si stampa «NaN €».
    const summary = await fetchDashboard(alice);

    expect(summary.monthlyAverageCents).toBe(0);
    expect(summary.currentMonthCents).toBe(0);
    expect(Number.isNaN(summary.monthlyAverageCents)).toBe(false);
  });
});

describe('righe dei riquadri', () => {
  it('ogni riga porta l’identificativo dell’occorrenza, per poterla confermare', async () => {
    await anExpense(alice, [{ dueDate: inMonth(-1, 10), baseGrossCents: 3_000 }]);

    const summary = await fetchDashboard(alice);
    const line = summary.overdue.lines[0];

    expect(line?.occurrenceId).toBeTypeOf('string');
    // Le date escono come stringhe: un istante serializzato porterebbe un
    // orario, e il fuso del browser potrebbe spostarlo di un giorno.
    expect(line?.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
