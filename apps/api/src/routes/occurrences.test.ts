import { randomUUID } from 'node:crypto';

import {
  type Expense,
  type ExpenseOccurrence,
  type Paginated,
  formatIsoDate,
  todayIn,
} from '@easygest/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * Le occorrenze si leggono e si correggono, non si creano.
 *
 * La `PATCH` è l'unico punto dell'API in cui una persona riscrive un numero che
 * ha generato il motore, ed è anche l'unico in cui si dichiara di aver pagato
 * qualcosa. Le due cose hanno conseguenze che non si vedono dalla risposta —
 * il convertito che dev'essere rifatto, la data di pagamento che non c'era —
 * e sono quelle che si provano qui.
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
const OWNED_CURRENCY = 'DKK';

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

let app: FastifyInstance;
let alice: TestUser;
let bob: TestUser;

interface TestUser {
  id: string;
  auth: { authorization: string };
}

const TODAY = todayIn('Europe/Rome', new Date());

async function createUser(): Promise<TestUser> {
  const user = await app.prisma.user.create({
    data: {
      email: `occ-route-${randomUUID()}@easygest.test`,
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

/** Crea una spesa passando dall'API, così le occorrenze esistono davvero. */
async function makeExpense(user: TestUser, body: Record<string, unknown> = {}): Promise<Expense> {
  const response = await app.inject({
    method: 'POST',
    url: '/expenses',
    headers: user.auth,
    payload: {
      name: 'Abbonamento',
      grossCents: 12_200,
      startDate: formatIsoDate(TODAY),
      ...body,
    },
  });
  return response.json<Expense>();
}

async function firstOccurrence(expenseId: string): Promise<string> {
  const row = await app.prisma.expenseOccurrence.findFirstOrThrow({
    where: { expenseId },
    orderBy: { dueDate: 'asc' },
    select: { id: true },
  });
  return row.id;
}

function patch(
  user: TestUser,
  id: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'PATCH', url: `/occurrences/${id}`, headers: user.auth, payload });
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  alice = await createUser();
  bob = await createUser();
});

afterEach(async () => {
  await app.prisma.expense.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
  await app.prisma.fxRate.deleteMany({ where: { quote: OWNED_CURRENCY } });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  await app.close();
});

describe('elenco', () => {
  it('senza credenziali non risponde', async () => {
    expect((await app.inject({ method: 'GET', url: '/occurrences' })).statusCode).toBe(401);
  });

  it('porta con s\u00e9 il nome della spesa', async () => {
    // Senza, disegnare un calendario vorrebbe dire chiedere una spesa per
    // riga solo per scrivere di cosa si tratta.
    const expense = await makeExpense(alice);
    const body = (
      await app.inject({
        method: 'GET',
        url: `/occurrences?expenseId=${expense.id}`,
        headers: alice.auth,
      })
    ).json<Paginated<ExpenseOccurrence>>();

    expect(body.items[0]?.expenseName).toBe('Abbonamento');
  });

  it('la finestra include gli estremi', async () => {
    const expense = await makeExpense(alice);
    const day = formatIsoDate(TODAY);
    const body = (
      await app.inject({
        method: 'GET',
        url: `/occurrences?expenseId=${expense.id}&from=${day}&to=${day}`,
        headers: alice.auth,
      })
    ).json<Paginated<ExpenseOccurrence>>();

    expect(body.total).toBe(1);
    expect(body.items[0]?.dueDate).toBe(day);
  });

  it('«da confermare» sono solo le pagate che nessuno ha guardato', async () => {
    // È la lista da cui ci si accorge di un aumento di prezzo: se ci finisse
    // dentro anche il resto non servirebbe a niente.
    const expense = await makeExpense(alice);
    const rows = await app.prisma.expenseOccurrence.findMany({
      where: { expenseId: expense.id },
      orderBy: { dueDate: 'asc' },
      select: { id: true },
      take: 3,
    });
    await app.prisma.expenseOccurrence.update({
      where: { id: rows[0]?.id },
      data: { status: 'PAID' },
    });
    await app.prisma.expenseOccurrence.update({
      where: { id: rows[1]?.id },
      data: { status: 'PAID', confirmedAt: new Date() },
    });

    const body = (
      await app.inject({ method: 'GET', url: '/occurrences?unconfirmed=true', headers: alice.auth })
    ).json<Paginated<ExpenseOccurrence>>();

    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe(rows[0]?.id);
  });

  it('le scadenze di Bob non sono di Alice', async () => {
    await makeExpense(bob);
    const body = (
      await app.inject({ method: 'GET', url: '/occurrences', headers: alice.auth })
    ).json<Paginated<ExpenseOccurrence>>();
    expect(body.total).toBe(0);
  });
});

describe('correzione', () => {
  it('marcata pagata senza dire quando, la data \u00e8 adesso', async () => {
    const expense = await makeExpense(alice);
    const id = await firstOccurrence(expense.id);

    const body = (await patch(alice, id, { status: 'PAID' })).json<ExpenseOccurrence>();
    expect(body.status).toBe('PAID');
    expect(body.paidAt).not.toBeNull();
  });

  it('riportata a prevista, la data di pagamento se ne va', async () => {
    // Lasciarla vorrebbe dire una riga che dice «non pagata» e riporta il
    // giorno in cui è stata pagata.
    const expense = await makeExpense(alice);
    const id = await firstOccurrence(expense.id);
    await patch(alice, id, { status: 'PAID' });

    const body = (await patch(alice, id, { status: 'PLANNED' })).json<ExpenseOccurrence>();
    expect(body.paidAt).toBeNull();
  });

  it('confermare scrive un istante, non un s\u00ec', async () => {
    const expense = await makeExpense(alice);
    const id = await firstOccurrence(expense.id);

    const confirmed = (await patch(alice, id, { confirmed: true })).json<ExpenseOccurrence>();
    expect(confirmed.confirmedAt).not.toBeNull();

    const doubted = (await patch(alice, id, { confirmed: false })).json<ExpenseOccurrence>();
    expect(doubted.confirmedAt).toBeNull();
  });

  it('correggere il totale rifà anche l\u2019imponibile', async () => {
    const expense = await makeExpense(alice);
    const id = await firstOccurrence(expense.id);

    const body = (await patch(alice, id, { grossCents: 24_400 })).json<ExpenseOccurrence>();
    expect(body.grossCents).toBe(24_400);
    expect(body.netCents).toBe(20_000);
  });

  it('cambiare la sola aliquota tiene fermo l\u2019imponibile', async () => {
    // È l'imponibile il dato letto sulla fattura; il totale è un conto.
    const expense = await makeExpense(alice);
    const id = await firstOccurrence(expense.id);

    const body = (await patch(alice, id, { vatRateBp: 1000 })).json<ExpenseOccurrence>();
    expect(body.netCents).toBe(10_000);
    expect(body.grossCents).toBe(11_000);
  });

  it('correggere l\u2019importo riconverte col cambio gi\u00e0 congelato', async () => {
    // Il tasso non si va a riprendere: è quello del giorno in cui la scadenza
    // è maturata, e correggere la cifra non cambia il giorno.
    await app.prisma.fxRate.create({
      data: {
        base: 'EUR',
        quote: OWNED_CURRENCY,
        date: TODAY,
        rate: '0.9200000000',
        source: 'test',
      },
    });
    const expense = await makeExpense(alice, { currency: OWNED_CURRENCY, grossCents: 10_000 });
    const id = await firstOccurrence(expense.id);

    const body = (await patch(alice, id, { grossCents: 20_000 })).json<ExpenseOccurrence>();
    expect(body.fxRate).toBe('0.92');
    expect(body.baseGrossCents).toBe(18_400);
  });

  it('non accetta un campo che non esiste', async () => {
    const expense = await makeExpense(alice);
    const id = await firstOccurrence(expense.id);

    const response = await patch(alice, id, { dueDate: '2030-01-01' });
    expect(response.statusCode).toBe(400);
  });

  it('non lascia correggere una scadenza di un altro', async () => {
    const expense = await makeExpense(bob);
    const id = await firstOccurrence(expense.id);

    expect((await patch(alice, id, { status: 'PAID' })).statusCode).toBe(404);
  });
});
