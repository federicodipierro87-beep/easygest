import { randomUUID } from 'node:crypto';

import {
  EXPENSE_ERROR_CODES,
  type Expense,
  type ExpenseFormInput,
  type Paginated,
  addDays,
  addMonths,
  formatIsoDate,
  todayIn,
} from '@easygest/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * Le spese sono la prima risorsa che scrivendo produce altre righe.
 *
 * Quindi qui non si prova solo che la `POST` risponda 201: si prova che dopo la
 * `POST` esistano le scadenze, che dopo una modifica del prezzo siano cambiate
 * solo quelle future, e che una spesa con dello storico non si lasci cancellare.
 * La meccanica degli elenchi — pagine, ordinamento, ricerca — è già provata in
 * `clients.test.ts` e non si ripete.
 *
 * Le date sono relative a oggi vero e non a una data fissa: la rotta legge
 * l'orologio attraverso le impostazioni dell'utente, e fissare il giorno qui
 * proverebbe qualcosa che in produzione non succede.
 */

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
const iso = formatIsoDate;

async function createUser(): Promise<TestUser> {
  const user = await app.prisma.user.create({
    data: {
      email: `exp-${randomUUID()}@easygest.test`,
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

interface ErrorBody {
  error: { code: string; details?: unknown };
}

function post(user: TestUser, body: Partial<ExpenseFormInput>): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/expenses',
    headers: user.auth,
    payload: { name: 'Abbonamento', grossCents: 12_200, startDate: iso(TODAY), ...body },
  });
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  alice = await createUser();
  bob = await createUser();
});

afterEach(async () => {
  await app.prisma.expense.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  await app.close();
});

describe('creazione', () => {
  it('senza credenziali non si arriva alle spese di nessuno', async () => {
    const response = await app.inject({ method: 'GET', url: '/expenses' });
    expect(response.statusCode).toBe(401);
  });

  it('crea la spesa e insieme le sue scadenze', async () => {
    const response = await post(alice, {});
    expect(response.statusCode).toBe(201);

    const body = response.json<Expense>();
    expect(body.nextDueDate).toBe(iso(TODAY));
    expect(body.occurrenceCount).toBe(14);
  });

  it('completa l\u2019imponibile a partire dal totale', async () => {
    // Un SaaS mostra solo la cifra addebitata sulla carta: farsi dare
    // l'imponibile vorrebbe dire chiedere un conto già fatto da `money.ts`.
    const body = (await post(alice, { grossCents: 12_200, vatRateBp: 2200 })).json<Expense>();
    expect(body.netCents).toBe(10_000);
    expect(body.grossCents).toBe(12_200);
  });

  it('rifiuta un riaddebito senza cliente indicando il campo da riempire', async () => {
    const response = await post(alice, { rebillMode: 'PASSTHROUGH' });
    expect(response.statusCode).toBe(400);

    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toContainEqual(expect.objectContaining({ field: 'clientId' }));
  });

  it('non lascia attribuire una spesa al cliente di un altro', async () => {
    // Prisma controlla che l'identificativo esista, non che sia di chi lo usa:
    // senza il controllo esplicito la spesa finirebbe nei report di Bob.
    const client = await app.prisma.client.create({
      data: { userId: bob.id, name: 'Cliente di Bob' },
      select: { id: true },
    });

    const response = await post(alice, { clientId: client.id, rebillMode: 'PASSTHROUGH' });
    expect(response.statusCode).toBe(422);

    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe(EXPENSE_ERROR_CODES.unknownRelation);
    expect(error.details).toEqual({ fields: ['clientId'] });

    await app.prisma.client.delete({ where: { id: client.id } });
  });

  it('una spesa in valuta estera senza cambi si ferma invece di sbagliare i report', async () => {
    // Il dollaro australiano non lo scrive nessuno: né gli altri file della
    // suite, né `seed:demo`. I cambi sono una tabella sola per tutti e i file
    // girano in parallelo sullo stesso database: con una valuta che qualcun
    // altro sincronizza il tasso esisterebbe per un attimo e questo test
    // fallirebbe solo quando i due capitano insieme — cioè a caso, e più
    // spesso in CI che qui.
    const response = await post(alice, { currency: 'AUD' });
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.code).toBe(EXPENSE_ERROR_CODES.missingFxRate);
  });
});

describe('lettura', () => {
  it('calcola l\u2019ultimo giorno utile per disdire', async () => {
    // Sessanta giorni di preavviso su un rinnovo annuale: la data che conta
    // non è il rinnovo, è quella dopo la quale si paga un altro anno.
    const created = (
      await post(alice, {
        recurrenceUnit: 'YEAR',
        startDate: iso(addMonths(TODAY, 3)),
        cancellationNoticeDays: 60,
      })
    ).json<Expense>();

    const response = await app.inject({
      method: 'GET',
      url: `/expenses/${created.id}`,
      headers: alice.auth,
    });
    const body = response.json<Expense>();
    expect(body.nextDueDate).toBe(iso(addMonths(TODAY, 3)));
    expect(body.nextCancellationDeadline).toBe(iso(addDays(addMonths(TODAY, 3), -60)));
  });

  it('senza preavviso non c\u2019\u00e8 nessuna scadenza per disdire', async () => {
    // `null` e non la data di rinnovo: non è che si può disdire fino
    // all'ultimo giorno, è che non c'è un termine da rispettare.
    const created = (await post(alice, {})).json<Expense>();
    const body = (
      await app.inject({ method: 'GET', url: `/expenses/${created.id}`, headers: alice.auth })
    ).json<Expense>();
    expect(body.nextCancellationDeadline).toBeNull();
  });

  it('filtra per finestra di scadenza guardando le occorrenze', async () => {
    // «Cosa scade a giugno» non è «cosa è iniziato a giugno»: un annuale
    // partito l'anno scorso scade a giugno pur non iniziando allora.
    await post(alice, { name: 'Mensile' });
    await post(alice, {
      name: 'Annuale lontano',
      recurrenceUnit: 'YEAR',
      startDate: iso(addMonths(TODAY, 8)),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/expenses?dueFrom=${iso(TODAY)}&dueTo=${iso(addDays(TODAY, 31))}`,
      headers: alice.auth,
    });
    const body = response.json<Paginated<Expense>>();
    expect(body.items.map((item) => item.name)).toEqual(['Mensile']);
  });

  it('le spese di Bob non compaiono fra quelle di Alice', async () => {
    await post(bob, { name: 'Roba di Bob' });
    const body = (await app.inject({ method: 'GET', url: '/expenses', headers: alice.auth })).json<
      Paginated<Expense>
    >();
    expect(body.total).toBe(0);
  });

  it('un identificativo di un altro utente risponde inesistente, non vietato', async () => {
    const created = (await post(bob, {})).json<Expense>();
    const response = await app.inject({
      method: 'GET',
      url: `/expenses/${created.id}`,
      headers: alice.auth,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('modifica', () => {
  it('l\u2019aumento di prezzo vale da qui in avanti', async () => {
    const created = (await post(alice, {})).json<Expense>();
    await app.prisma.expenseOccurrence.updateMany({
      where: { expenseId: created.id, dueDate: TODAY },
      data: { status: 'PAID' },
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/expenses/${created.id}`,
      headers: alice.auth,
      payload: { name: 'Abbonamento', grossCents: 24_400, startDate: iso(TODAY) },
    });
    expect(response.statusCode).toBe(200);

    const rows = await app.prisma.expenseOccurrence.findMany({
      where: { expenseId: created.id },
      orderBy: { dueDate: 'asc' },
      select: { grossCents: true },
    });
    expect(rows[0]?.grossCents).toBe(12_200); // pagata al vecchio prezzo
    expect(rows[1]?.grossCents).toBe(24_400);
  });

  it('sospendere una spesa toglie le scadenze future', async () => {
    const created = (await post(alice, {})).json<Expense>();

    await app.inject({
      method: 'PUT',
      url: `/expenses/${created.id}`,
      headers: alice.auth,
      payload: {
        name: 'Abbonamento',
        grossCents: 12_200,
        startDate: iso(TODAY),
        status: 'PAUSED',
      },
    });

    expect(await app.prisma.expenseOccurrence.count({ where: { expenseId: created.id } })).toBe(0);
  });
});

describe('cancellazione', () => {
  it('una spesa con solo previsioni si cancella', async () => {
    const created = (await post(alice, {})).json<Expense>();
    const response = await app.inject({
      method: 'DELETE',
      url: `/expenses/${created.id}`,
      headers: alice.auth,
    });
    expect(response.statusCode).toBe(204);
    expect(await app.prisma.expenseOccurrence.count({ where: { expenseId: created.id } })).toBe(0);
  });

  it('una spesa con storico si rifiuta di sparire', async () => {
    // Le occorrenze cadono in cascata: cancellare porterebbe via anche quanto
    // è stato pagato, e nessun report se ne accorgerebbe.
    const created = (await post(alice, {})).json<Expense>();
    await app.prisma.expenseOccurrence.updateMany({
      where: { expenseId: created.id, dueDate: TODAY },
      data: { status: 'PAID' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/expenses/${created.id}`,
      headers: alice.auth,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.details).toEqual({ occurrences: 1 });
  });
});
