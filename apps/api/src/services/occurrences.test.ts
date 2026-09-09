import { randomUUID } from 'node:crypto';

import { formatIsoDate, parseIsoDate } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { type Env, parseEnv } from '../config/env';
import type { Expense } from '../generated/prisma/client';
import { ResourceError } from '../lib/resources';
import { type OccurrenceContext, syncOccurrences } from './occurrences';

/**
 * Quello che si prova qui non è «genera le date giuste» — quello è già provato
 * in `recurrence.test.ts`, senza database e su un centinaio di casi.
 *
 * Qui si prova la parte che il motore non sa: cosa succede alle righe che
 * c'erano già. È la sola parte in cui un errore distrugge dati invece di
 * mostrare un numero sbagliato, ed è anche la sola che non si può verificare
 * senza una tabella vera.
 */

/**
 * La valuta di questo file, e di nessun altro.
 *
 * I cambi non hanno un `userId`: sono una tabella sola per tutti, quindi due
 * file che girano in parallelo non si isolano per riga come fanno altrove. Si
 * isolano per valuta — ognuno la sua, e la pulizia cancella solo quella.
 *
 * Non è una delle valute di `seed:demo`: la suite gira sullo stesso database
 * dello sviluppo, e cancellare i cambi dei dati dimostrativi a ogni `npm test`
 * lascerebbe quelle spese senza il tasso che serve a rigenerarle.
 */
const OWNED_CURRENCY = 'CAD';

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

let app: FastifyInstance;
let userId: string;

const d = (value: string): Date => {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error(`Data di test non valida: ${value}`);
  return parsed;
};

/** Il lunedì da cui si conta tutto, così le date restano leggibili. */
const TODAY = d('2027-03-15');
const ctx: OccurrenceContext = { baseCurrency: 'EUR', today: TODAY };

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  const user = await app.prisma.user.create({
    data: {
      email: `occ-${randomUUID()}@easygest.test`,
      displayName: 'Utente di prova',
      passwordHash: 'non-usato',
      settings: { create: {} },
    },
    select: { id: true },
  });
  userId = user.id;
});

afterEach(async () => {
  await app.prisma.expense.deleteMany({ where: { userId } });
  await app.prisma.fxRate.deleteMany({ where: { quote: OWNED_CURRENCY } });
});

afterAll(async () => {
  await app.prisma.user.delete({ where: { id: userId } });
  await app.close();
});

async function makeExpense(overrides: Partial<Expense> = {}): Promise<Expense> {
  return app.prisma.expense.create({
    data: {
      userId,
      name: 'Abbonamento di prova',
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: 12_200,
      currency: 'EUR',
      recurrenceUnit: 'MONTH',
      recurrenceInterval: 1,
      startDate: TODAY,
      status: 'ACTIVE',
      ...overrides,
    },
  });
}

/** Le scadenze in tabella, in ordine, come stringhe leggibili. */
async function dueDates(expenseId: string): Promise<string[]> {
  const rows = await app.prisma.expenseOccurrence.findMany({
    where: { expenseId },
    orderBy: { dueDate: 'asc' },
    select: { dueDate: true },
  });
  return rows.map((row) => formatIsoDate(row.dueDate));
}

describe('prima materializzazione', () => {
  it('copre l\u2019orizzonte e non un giorno di pi\u00f9', async () => {
    const expense = await makeExpense();
    const result = await syncOccurrences(app.prisma, expense, ctx);

    // 15 marzo 2027 più tredici mensilità: l'ultima cade il 15 aprile 2028,
    // cioè esattamente sull'orizzonte, e la successiva no.
    expect(result.created).toBe(14);
    expect(result.horizon).toEqual(d('2028-04-15'));
    const dates = await dueDates(expense.id);
    expect(dates[0]).toBe('2027-03-15');
    expect(dates.at(-1)).toBe('2028-04-15');
  });

  it('non inventa lo storico di una spesa che parte da lontano', async () => {
    // Un abbonamento aperto nel 2025 e inserito solo oggi: le rate già pagate
    // non sono affar nostro, e scriverle `PLANNED` le farebbe sembrare debiti.
    const expense = await makeExpense({ startDate: d('2025-01-15') });
    await syncOccurrences(app.prisma, expense, ctx);

    const dates = await dueDates(expense.id);
    expect(dates[0]).toBe('2027-03-15');
  });

  it('tiene l\u2019ancora anche quando lo storico non si materializza', async () => {
    // Il 31 gennaio è la data vera della serie: partendo da lì, marzo cade il
    // 31 e non il 28, che è quello che darebbe una serie riancorata a oggi.
    const expense = await makeExpense({ startDate: d('2027-01-31') });
    await syncOccurrences(app.prisma, expense, ctx);

    const dates = await dueDates(expense.id);
    expect(dates[0]).toBe('2027-03-31');
    expect(dates[1]).toBe('2027-04-30');
    expect(dates[2]).toBe('2027-05-31');
  });

  it('si ferma alla fine del contratto', async () => {
    const expense = await makeExpense({ endDate: d('2027-06-30') });
    const result = await syncOccurrences(app.prisma, expense, ctx);

    expect(result.created).toBe(4);
    expect(await dueDates(expense.id)).toEqual([
      '2027-03-15',
      '2027-04-15',
      '2027-05-15',
      '2027-06-15',
    ]);
  });

  it('una tantum produce una riga sola, senza periodo di fine', async () => {
    const expense = await makeExpense({ recurrenceUnit: 'ONE_OFF' });
    await syncOccurrences(app.prisma, expense, ctx);

    const rows = await app.prisma.expenseOccurrence.findMany({
      where: { expenseId: expense.id },
      select: { dueDate: true, periodStart: true, periodEnd: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.periodStart).toEqual(TODAY);
    expect(rows[0]?.periodEnd).toBeNull();
  });

  it('il periodo finisce il giorno prima della scadenza successiva', async () => {
    // Se finisse lo stesso giorno, sommare i costi per mese conterebbe due
    // volte il 15 aprile.
    const expense = await makeExpense();
    await syncOccurrences(app.prisma, expense, ctx);

    const row = await app.prisma.expenseOccurrence.findFirst({
      where: { expenseId: expense.id, dueDate: TODAY },
      select: { periodStart: true, periodEnd: true },
    });
    expect(row?.periodStart).toEqual(d('2027-03-15'));
    expect(row?.periodEnd).toEqual(d('2027-04-14'));
  });

  it('copia gli importi invece di rimandare alla spesa', async () => {
    const expense = await makeExpense();
    await syncOccurrences(app.prisma, expense, ctx);

    const row = await app.prisma.expenseOccurrence.findFirstOrThrow({
      where: { expenseId: expense.id },
      select: { netCents: true, vatRateBp: true, grossCents: true, baseGrossCents: true },
    });
    expect(row).toEqual({
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: 12_200,
      baseGrossCents: 12_200,
    });
  });
});

describe('rilanciata', () => {
  it('due volte di fila non scrive niente', async () => {
    const expense = await makeExpense();
    await syncOccurrences(app.prisma, expense, ctx);
    const second = await syncOccurrences(app.prisma, expense, ctx);

    expect(second.created).toBe(0);
    expect(second.removed).toBe(0);
    expect(await app.prisma.expenseOccurrence.count({ where: { expenseId: expense.id } })).toBe(14);
  });

  it('il giorno dopo aggiunge in coda e non tocca il passato', async () => {
    const expense = await makeExpense();
    await syncOccurrences(app.prisma, expense, ctx);

    // Un mese dopo l'orizzonte si è spostato in avanti di un mese.
    const later = await syncOccurrences(app.prisma, expense, {
      ...ctx,
      today: d('2027-04-16'),
    });

    expect(later.created).toBe(1);
    expect(later.removed).toBe(0);
    const dates = await dueDates(expense.id);
    // La rata del 15 marzo, ormai scaduta, è ancora lì.
    expect(dates[0]).toBe('2027-03-15');
    expect(dates.at(-1)).toBe('2028-05-15');
  });
});

describe('quando la spesa cambia', () => {
  it('il nuovo prezzo vale per le rate future, non per quelle gi\u00e0 pagate', async () => {
    const expense = await makeExpense();
    await syncOccurrences(app.prisma, expense, ctx);

    // La prima rata risulta pagata al vecchio prezzo.
    await app.prisma.expenseOccurrence.update({
      where: { expenseId_dueDate: { expenseId: expense.id, dueDate: TODAY } },
      data: { status: 'PAID', paidAt: TODAY },
    });

    const raised = await app.prisma.expense.update({
      where: { id: expense.id },
      data: { netCents: 20_000, grossCents: 24_400 },
    });
    const result = await syncOccurrences(app.prisma, raised, ctx);

    expect(result.updated).toBe(13);
    const paid = await app.prisma.expenseOccurrence.findFirstOrThrow({
      where: { expenseId: expense.id, dueDate: TODAY },
      select: { grossCents: true },
    });
    expect(paid.grossCents).toBe(12_200);

    const next = await app.prisma.expenseOccurrence.findFirstOrThrow({
      where: { expenseId: expense.id, dueDate: d('2027-04-15') },
      select: { grossCents: true },
    });
    expect(next.grossCents).toBe(24_400);
  });

  it('spostare l\u2019inizio riallinea il futuro e lascia stare lo storico', async () => {
    const expense = await makeExpense();
    await syncOccurrences(app.prisma, expense, ctx);
    await app.prisma.expenseOccurrence.update({
      where: { expenseId_dueDate: { expenseId: expense.id, dueDate: TODAY } },
      data: { status: 'PAID' },
    });

    const moved = await app.prisma.expense.update({
      where: { id: expense.id },
      data: { startDate: d('2027-03-20') },
    });
    await syncOccurrences(app.prisma, moved, ctx);

    const dates = await dueDates(expense.id);
    expect(dates[0]).toBe('2027-03-15'); // pagata: resta
    expect(dates[1]).toBe('2027-03-20');
    expect(dates[2]).toBe('2027-04-20');
  });

  it('cambiare intervallo corregge anche il periodo delle date sopravvissute', async () => {
    // Da mensile a bimestrale il 15 maggio resta al suo posto, ma smette di
    // coprire un mese e ne copre due: la data uguale nasconde un dato diverso.
    const expense = await makeExpense();
    await syncOccurrences(app.prisma, expense, ctx);

    const doubled = await app.prisma.expense.update({
      where: { id: expense.id },
      data: { recurrenceInterval: 2 },
    });
    await syncOccurrences(app.prisma, doubled, ctx);

    const row = await app.prisma.expenseOccurrence.findFirstOrThrow({
      where: { expenseId: expense.id, dueDate: d('2027-05-15') },
      select: { periodEnd: true },
    });
    expect(row.periodEnd).toEqual(d('2027-07-14'));
  });

  it('accorciare il contratto toglie le rate oltre la nuova fine', async () => {
    const expense = await makeExpense();
    await syncOccurrences(app.prisma, expense, ctx);

    const shortened = await app.prisma.expense.update({
      where: { id: expense.id },
      data: { endDate: d('2027-05-31') },
    });
    const result = await syncOccurrences(app.prisma, shortened, ctx);

    expect(result.removed).toBe(11);
    expect(await dueDates(expense.id)).toEqual(['2027-03-15', '2027-04-15', '2027-05-15']);
  });
});

describe('quando la spesa smette di produrre', () => {
  it('in pausa il futuro sparisce e il passato resta', async () => {
    const expense = await makeExpense({ startDate: d('2027-02-15') });
    await syncOccurrences(app.prisma, expense, ctx);
    // Una rata scaduta e mai pagata: è un debito, non un residuo.
    await app.prisma.expenseOccurrence.create({
      data: {
        userId,
        expenseId: expense.id,
        dueDate: d('2027-02-15'),
        netCents: 10_000,
        vatRateBp: 2200,
        grossCents: 12_200,
        baseGrossCents: 12_200,
      },
    });

    const paused = await app.prisma.expense.update({
      where: { id: expense.id },
      data: { status: 'PAUSED' },
    });
    const result = await syncOccurrences(app.prisma, paused, ctx);

    expect(result.created).toBe(0);
    expect(await dueDates(expense.id)).toEqual(['2027-02-15']);
  });

  it('riattivata ricostruisce il futuro senza duplicare', async () => {
    const expense = await makeExpense();
    await syncOccurrences(app.prisma, expense, ctx);
    const paused = await app.prisma.expense.update({
      where: { id: expense.id },
      data: { status: 'PAUSED' },
    });
    await syncOccurrences(app.prisma, paused, ctx);

    const resumed = await app.prisma.expense.update({
      where: { id: expense.id },
      data: { status: 'ACTIVE' },
    });
    await syncOccurrences(app.prisma, resumed, ctx);

    expect(await app.prisma.expenseOccurrence.count({ where: { expenseId: expense.id } })).toBe(14);
  });

  it('non tocca una rata futura gi\u00e0 pagata in anticipo', async () => {
    const expense = await makeExpense();
    await syncOccurrences(app.prisma, expense, ctx);
    await app.prisma.expenseOccurrence.update({
      where: { expenseId_dueDate: { expenseId: expense.id, dueDate: d('2027-04-15') } },
      data: { status: 'PAID', paidAt: TODAY },
    });

    const cancelled = await app.prisma.expense.update({
      where: { id: expense.id },
      data: { status: 'CANCELLED' },
    });
    await syncOccurrences(app.prisma, cancelled, ctx);

    expect(await dueDates(expense.id)).toEqual(['2027-04-15']);
  });
});

describe('valuta estera', () => {
  it('congela il cambio e converte il totale', async () => {
    await app.prisma.fxRate.create({
      data: {
        base: 'EUR',
        quote: OWNED_CURRENCY,
        date: TODAY,
        rate: '0.9200000000',
        source: 'test',
      },
    });
    const expense = await makeExpense({
      currency: OWNED_CURRENCY,
      netCents: 10_000,
      grossCents: 10_000,
    });
    await syncOccurrences(app.prisma, expense, ctx);

    const row = await app.prisma.expenseOccurrence.findFirstOrThrow({
      where: { expenseId: expense.id, dueDate: TODAY },
      select: { fxRate: true, grossCents: true, baseGrossCents: true },
    });
    expect(row.grossCents).toBe(10_000);
    expect(row.baseGrossCents).toBe(9_200);
    expect(row.fxRate?.toString()).toBe('0.92');
  });

  it('usa il cambio di oggi anche per le scadenze lontane', async () => {
    // Il cambio del 2028 non esiste. Chiederlo con la data di scadenza darebbe
    // comunque quello di oggi, ma dichiarato vecchio di un anno e rifiutato:
    // per un'occorrenza futura il cambio è una stima, e va detto.
    await app.prisma.fxRate.create({
      data: {
        base: 'EUR',
        quote: OWNED_CURRENCY,
        date: TODAY,
        rate: '0.9200000000',
        source: 'test',
      },
    });
    const expense = await makeExpense({
      currency: OWNED_CURRENCY,
      netCents: 10_000,
      grossCents: 10_000,
    });
    await syncOccurrences(app.prisma, expense, ctx);

    const last = await app.prisma.expenseOccurrence.findFirstOrThrow({
      where: { expenseId: expense.id, dueDate: d('2028-04-15') },
      select: { baseGrossCents: true },
    });
    expect(last.baseGrossCents).toBe(9_200);
  });

  it('senza cambio si ferma invece di scrivere il totale sbagliato', async () => {
    const expense = await makeExpense({ currency: OWNED_CURRENCY });
    await expect(syncOccurrences(app.prisma, expense, ctx)).rejects.toBeInstanceOf(ResourceError);
    expect(await app.prisma.expenseOccurrence.count({ where: { expenseId: expense.id } })).toBe(0);
  });
});
