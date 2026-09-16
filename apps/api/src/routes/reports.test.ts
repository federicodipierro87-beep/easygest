import { randomUUID } from 'node:crypto';

import {
  LEDGER_MAX_ROWS,
  type ReportLedger,
  type ReportSummary,
  parseIsoDate,
} from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * Le rotte dei report.
 *
 * La piega è già provata in `packages/shared/src/reports.test.ts`, che è pura
 * e veloce: qui resta quello che si vede solo passando dal database e dalla
 * rete — la validazione del periodo, l'isolamento fra utenti, la conversione
 * del cambio che `shared` non può fare, e il fatto che riepilogo e dettaglio
 * leggano davvero le stesse righe.
 *
 * Quest'ultimo è il test che vale più di tutti: è la promessa che chi somma la
 * colonna del CSV in Excel ottiene il numero che vede a schermo.
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

const PERIOD = { from: '2027-01-01', to: '2027-03-31' };

const d = (value: string): Date => {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error(`Data di test non valida: ${value}`);
  return parsed;
};

async function createUser(): Promise<TestUser> {
  const user = await app.prisma.user.create({
    data: {
      email: `report-${randomUUID()}@easygest.test`,
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

interface ExpenseOptions {
  who: TestUser;
  name?: string;
  dueDates: Date[];
  status?: 'PLANNED' | 'PAID' | 'SKIPPED' | 'CANCELLED';
  grossCents?: number;
  currency?: string;
  fxRate?: string | null;
  baseGrossCents?: number;
  rebillMode?: 'NONE' | 'PASSTHROUGH' | 'MARKUP' | 'FIXED';
  rebillMarkupBp?: number | null;
  rebillAmountCents?: number | null;
  clientName?: string;
  categoryName?: string;
}

async function anExpense(options: ExpenseOptions): Promise<void> {
  const gross = options.grossCents ?? 12_200;

  // Cliente e categoria si creano prima e si collegano per identificativo:
  // passare `userId` come scalare mette Prisma nella variante «unchecked»,
  // dove le relazioni con la chiave su questa tabella non sono annidabili.
  const client =
    options.clientName === undefined
      ? null
      : await app.prisma.client.create({
          data: { userId: options.who.id, name: options.clientName },
          select: { id: true },
        });
  const category =
    options.categoryName === undefined
      ? null
      : await app.prisma.category.create({
          data: { userId: options.who.id, name: options.categoryName },
          select: { id: true },
        });

  await app.prisma.expense.create({
    data: {
      userId: options.who.id,
      name: options.name ?? 'Hosting',
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: gross,
      currency: options.currency ?? 'EUR',
      recurrenceUnit: 'MONTH',
      recurrenceInterval: 1,
      startDate: options.dueDates[0] ?? d('2027-01-01'),
      status: 'ACTIVE',
      rebillMode: options.rebillMode ?? 'NONE',
      rebillMarkupBp: options.rebillMarkupBp ?? null,
      rebillAmountCents: options.rebillAmountCents ?? null,
      clientId: client?.id ?? null,
      categoryId: category?.id ?? null,
      occurrences: {
        create: options.dueDates.map((dueDate) => ({
          userId: options.who.id,
          dueDate,
          periodStart: dueDate,
          netCents: 10_000,
          vatRateBp: 2200,
          grossCents: gross,
          currency: options.currency ?? 'EUR',
          fxRate: options.fxRate ?? null,
          baseGrossCents: options.baseGrossCents ?? gross,
          status: options.status ?? 'PLANNED',
        })),
      },
    },
  });
}

async function fetchSummary(who: TestUser, period = PERIOD): Promise<ReportSummary> {
  const response = await app.inject({
    method: 'GET',
    url: `/reports?from=${period.from}&to=${period.to}`,
    headers: who.auth,
  });
  expect(response.statusCode).toBe(200);
  return response.json<ReportSummary>();
}

async function fetchLedger(who: TestUser, period = PERIOD): Promise<ReportLedger> {
  const response = await app.inject({
    method: 'GET',
    url: `/reports/ledger?from=${period.from}&to=${period.to}`,
    headers: who.auth,
  });
  expect(response.statusCode).toBe(200);
  return response.json<ReportLedger>();
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  alice = await createUser();
  bob = await createUser();
});

afterEach(async () => {
  await app.prisma.expense.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
  await app.prisma.client.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
  await app.prisma.category.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  await app.close();
});

describe('validazione del periodo', () => {
  it('senza sessione risponde 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports?from=2027-01-01&to=2027-01-31',
    });
    expect(response.statusCode).toBe(401);
  });

  it('senza periodo risponde 400, invece di inventarne uno', async () => {
    // Un intervallo di default nascosto produrrebbe numeri veri attribuiti al
    // periodo sbagliato: l'errore che non si vede, perché sembra plausibile.
    const response = await app.inject({ method: 'GET', url: '/reports', headers: alice.auth });
    expect(response.statusCode).toBe(400);
  });

  it('una fine che precede l’inizio è un 400 che indica il campo', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports?from=2027-03-31&to=2027-01-01',
      headers: alice.auth,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('to');
  });

  it('un periodo oltre i tre anni è un 400', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports?from=2020-01-01&to=2027-01-01',
      headers: alice.auth,
    });
    expect(response.statusCode).toBe(400);
  });

  it('una data storta esce con il suo messaggio, non con «Invalid input»', async () => {
    // `parseBody` legge `issue.message` e basta. Finché il controllo della data
    // stava dentro un'unione, quel campo conteneva l'inglese generico di Zod e
    // il messaggio italiano restava sepolto in `issues[0].errors`: questo è il
    // test che lo sorveglia dalla parte da cui si vede, cioè la risposta.
    const response = await app.inject({
      method: 'GET',
      url: '/reports?from=ieri&to=2027-01-01',
      headers: alice.auth,
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { details: { field: string; message: string }[] } }>();
    expect(body.error.details).toEqual([
      { field: 'from', message: 'Data non valida: «ieri», attesa 2027-03-15' },
    ]);
  });
});

describe('isolamento', () => {
  it('le righe di Bob non entrano nei report di Alice', async () => {
    // È l'unico difetto di questa fase che non si rimedia dopo: una volta che
    // i numeri di un altro utente sono comparsi, sono comparsi.
    await anExpense({ who: bob, dueDates: [d('2027-02-01')], baseGrossCents: 99_000 });

    const summary = await fetchSummary(alice);
    const ledger = await fetchLedger(alice);

    expect(summary.totalCents).toBe(0);
    expect(summary.count).toBe(0);
    expect(ledger.rows).toEqual([]);
  });
});

describe('periodo', () => {
  it('include gli estremi e taglia quello che sta fuori', async () => {
    await anExpense({
      who: alice,
      dueDates: [d('2026-12-31'), d('2027-01-01'), d('2027-03-31'), d('2027-04-01')],
      baseGrossCents: 1_000,
    });

    const summary = await fetchSummary(alice);
    expect(summary.count).toBe(2);
    expect(summary.totalCents).toBe(2_000);
  });
});

describe('valuta', () => {
  it('somma il controvalore congelato, non il lordo in valuta', async () => {
    // Sommare `grossCents` darebbe 27 200 invece di 21 200, e sembrerebbe un
    // numero plausibile: è il motivo per cui questo test esiste.
    await anExpense({ who: alice, dueDates: [d('2027-01-10')], grossCents: 12_200 });
    await anExpense({
      who: alice,
      name: 'Dominio',
      dueDates: [d('2027-02-10')],
      currency: 'USD',
      grossCents: 15_000,
      fxRate: '0.6000000000',
      baseGrossCents: 9_000,
    });

    const summary = await fetchSummary(alice);

    expect(summary.totalCents).toBe(21_200);
    expect(summary.foreignCount).toBe(1);
    expect(summary.baseCurrency).toBe('EUR');
  });
});

describe('margine teorico', () => {
  it('col ricarico è la differenza fra riaddebito e costo', async () => {
    // 12 200 + 20% = 14 640, meno il costo di 12 200, fa 2440.
    await anExpense({
      who: alice,
      dueDates: [d('2027-01-10')],
      rebillMode: 'MARKUP',
      rebillMarkupBp: 2_000,
      clientName: 'Rossi srl',
    });

    const summary = await fetchSummary(alice);
    const client = summary.byClient.find((bucket) => bucket.id !== null);

    expect(client?.label).toBe('Rossi srl');
    expect(client?.rebillCents).toBe(14_640);
    expect(client?.theoreticalMarginCents).toBe(2_440);
  });

  it('a forfait ignora il costo e usa l’importo concordato', async () => {
    await anExpense({
      who: alice,
      dueDates: [d('2027-01-10')],
      rebillMode: 'FIXED',
      rebillAmountCents: 20_000,
      clientName: 'Bianchi spa',
    });

    const summary = await fetchSummary(alice);
    const client = summary.byClient.find((bucket) => bucket.id !== null);

    expect(client?.rebillCents).toBe(20_000);
    expect(client?.theoreticalMarginCents).toBe(7_800);
  });

  it('porta il riaddebito in valuta base col cambio dell’occorrenza', async () => {
    // `rebillGrossCents` lavora nella valuta della spesa: 15 000 dollari a
    // costo diventano 15 000, e il cambio 0,6 li porta a 9000 euro. Se la
    // conversione mancasse, il margine sarebbe di 6000 euro inventati.
    await anExpense({
      who: alice,
      dueDates: [d('2027-01-10')],
      currency: 'USD',
      grossCents: 15_000,
      fxRate: '0.6000000000',
      baseGrossCents: 9_000,
      rebillMode: 'PASSTHROUGH',
      clientName: 'Rossi srl',
    });

    const summary = await fetchSummary(alice);
    const client = summary.byClient.find((bucket) => bucket.id !== null);

    expect(client?.rebillCents).toBe(9_000);
    expect(client?.theoreticalMarginCents).toBe(0);
  });
});

describe('riepilogo e dettaglio', () => {
  it('leggono le stesse righe, al centesimo', async () => {
    // È la prova della promessa fatta a chi apre il CSV: sommare la colonna
    // del controvalore deve dare il totale che si legge a schermo.
    await anExpense({
      who: alice,
      dueDates: [d('2027-01-10'), d('2027-02-10')],
      baseGrossCents: 4_321,
    });
    await anExpense({
      who: alice,
      name: 'Licenza',
      dueDates: [d('2027-03-10')],
      baseGrossCents: 1_234,
      status: 'SKIPPED',
    });

    const [summary, ledger] = await Promise.all([fetchSummary(alice), fetchLedger(alice)]);

    const summable = ledger.rows.filter(
      (row) => row.status !== 'SKIPPED' && row.status !== 'CANCELLED',
    );
    expect(summable.reduce((sum, row) => sum + row.baseGrossCents, 0)).toBe(summary.totalCents);
    expect(summable).toHaveLength(summary.count);
    // La saltata resta nel dettaglio: il CSV racconta cosa è successo, il
    // riepilogo cosa è costato.
    expect(ledger.rows).toHaveLength(3);
  });

  it('il dettaglio dichiara di essere completo quando lo è', async () => {
    await anExpense({ who: alice, dueDates: [d('2027-01-10')] });

    const ledger = await fetchLedger(alice);
    expect(ledger.truncated).toBe(false);
    expect(LEDGER_MAX_ROWS).toBeGreaterThan(ledger.rows.length);
  });

  it('le date del dettaglio sono giorni, non istanti', async () => {
    await anExpense({ who: alice, dueDates: [d('2027-01-10')], status: 'PAID' });

    const ledger = await fetchLedger(alice);
    expect(ledger.rows[0]?.dueDate).toBe('2027-01-10');
    // Un istante serializzato porterebbe un orario, e il fuso del browser
    // potrebbe spostarlo di un giorno.
    expect(ledger.rows[0]?.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('il cambio resta la stringa a dieci decimali che c’è in tabella', async () => {
    await anExpense({
      who: alice,
      dueDates: [d('2027-01-10')],
      currency: 'USD',
      fxRate: '0.6000000000',
      baseGrossCents: 7_320,
    });

    const ledger = await fetchLedger(alice);
    expect(ledger.rows[0]?.fxRate).toBe('0.6');
  });
});
