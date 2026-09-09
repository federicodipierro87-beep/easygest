import { randomUUID } from 'node:crypto';

import { RESOURCE_ERROR_CODES } from '@easygest/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * Come per i fornitori, questo file è corto di proposito: la meccanica degli
 * elenchi è verificata altrove.
 *
 * Qui restano le due cose che riguardano solo i metodi di pagamento — la
 * scadenza, che è un dato a due campi e non deve poter esistere a metà, e le
 * ultime quattro cifre, che sono un criterio di ricerca vero — più il 409 di
 * cancellazione, che va guardato perché la sua forma è condivisa con risorse
 * che hanno una relazione in più.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

let app: FastifyInstance;
let alice: { id: string; auth: { authorization: string } };
let bob: { id: string; auth: { authorization: string } };

async function createUser(): Promise<{ id: string; auth: { authorization: string } }> {
  const user = await app.prisma.user.create({
    data: {
      email: `test-${randomUUID()}@easygest.test`,
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

interface PaymentMethodBody {
  id: string;
  label: string;
  type: string;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  isActive: boolean;
  expenseCount: number;
}

interface ErrorBody {
  error: { code: string; details?: unknown };
}

/**
 * Il tipo di ritorno è dichiarato invece che dedotto: `inject` ha una firma
 * sovraccaricata che, restituita da una funzione non annotata, resta un'unione
 * irrisolta e fa perdere il tipo a ogni `response.json()` a valle.
 */
async function post(
  who: typeof alice,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: '/payment-methods',
    headers: who.auth,
    payload: body,
  });
}

async function createPaymentMethod(
  who: typeof alice,
  body: Record<string, unknown>,
): Promise<PaymentMethodBody> {
  const response = await post(who, body);
  expect(response.statusCode).toBe(201);
  return response.json<PaymentMethodBody>();
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  [alice, bob] = await Promise.all([createUser(), createUser()]);
});

afterEach(async () => {
  const where = { userId: { in: [alice.id, bob.id] } };
  await app.prisma.expense.deleteMany({ where });
  await app.prisma.paymentMethod.deleteMany({ where });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  await app.close();
});

it('rifiuta una scadenza a metà', async () => {
  // Un mese senza anno passerebbe volentieri: è un numero valido in un campo
  // facoltativo. Si salverebbe, e il promemoria della Fase 4 non saprebbe che
  // farsene senza che nessuno abbia mai visto un errore.
  const monthOnly = await post(alice, { label: 'Carta', type: 'CARD', expiryMonth: 3 });
  expect(monthOnly.statusCode).toBe(400);
  expect(monthOnly.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');

  const yearOnly = await post(alice, { label: 'Carta', type: 'CARD', expiryYear: 2027 });
  expect(yearOnly.statusCode).toBe(400);

  const both = await createPaymentMethod(alice, {
    label: 'Carta',
    type: 'CARD',
    expiryMonth: 3,
    expiryYear: 2027,
  });
  expect(both.expiryMonth).toBe(3);
  expect(both.expiryYear).toBe(2027);
});

it('non trasforma i campi vuoti di un form in una scadenza a gennaio dell’anno zero', async () => {
  // Una casella non compilata arriva come stringa vuota, e `z.coerce.number()`
  // la convertirebbe in `0`: un mese di scadenza pari a zero, salvato senza
  // che nessuno protesti.
  const created = await createPaymentMethod(alice, {
    label: 'Contanti',
    type: 'CASH',
    expiryMonth: '',
    expiryYear: '',
    last4: '',
  });

  expect(created.expiryMonth).toBeNull();
  expect(created.expiryYear).toBeNull();
  expect(created.last4).toBeNull();
});

it('cerca nelle ultime quattro cifre, non solo nell’etichetta', async () => {
  await createPaymentMethod(alice, { label: 'Carta aziendale', type: 'CARD', last4: '4242' });
  await createPaymentMethod(alice, { label: 'PayPal', type: 'PAYPAL' });

  // Si arriva qui da una riga dell'estratto conto, dove il nome che hai dato
  // tu alla carta non compare da nessuna parte.
  const response = await app.inject({
    method: 'GET',
    url: '/payment-methods?q=4242',
    headers: alice.auth,
  });

  const body = response.json<{ items: PaymentMethodBody[]; total: number }>();
  expect(body.total).toBe(1);
  expect(body.items[0]?.label).toBe('Carta aziendale');
});

it('rifiuta di cancellare un metodo di pagamento con dello storico', async () => {
  const created = await createPaymentMethod(alice, { label: 'Con Storico', type: 'CARD' });
  await app.prisma.expense.create({
    data: {
      userId: alice.id,
      paymentMethodId: created.id,
      name: 'Abbonamento',
      netCents: 1_500,
      grossCents: 1_830,
      startDate: new Date('2026-01-01'),
    },
  });

  const response = await app.inject({
    method: 'DELETE',
    url: `/payment-methods/${created.id}`,
    headers: alice.auth,
  });

  expect(response.statusCode).toBe(409);
  const body = response.json<ErrorBody>();
  expect(body.error.code).toBe(RESOURCE_ERROR_CODES.inUse);
  // `documents` c'è e vale zero: nessun documento punta a un metodo di
  // pagamento, ma il formato dei dettagli è uno solo e un frontend che
  // trovasse il campo assente stamperebbe «undefined documenti».
  expect(body.error.details).toEqual({ expenses: 1, documents: 0 });
});

it('cancella un metodo di pagamento che non ha storico', async () => {
  const created = await createPaymentMethod(alice, { label: 'Mai usata', type: 'CARD' });

  const response = await app.inject({
    method: 'DELETE',
    url: `/payment-methods/${created.id}`,
    headers: alice.auth,
  });

  expect(response.statusCode).toBe(204);
});

it('non lascia vedere né toccare i metodi di pagamento di un altro utente', async () => {
  const ofBob = await createPaymentMethod(bob, { label: 'Riservata', type: 'CARD' });

  const list = await app.inject({ method: 'GET', url: '/payment-methods', headers: alice.auth });
  expect(list.json<{ total: number }>().total).toBe(0);

  const read = await app.inject({
    method: 'GET',
    url: `/payment-methods/${ofBob.id}`,
    headers: alice.auth,
  });
  expect(read.statusCode).toBe(404);
});

it('rifiuta un tipo che non è fra quelli previsti', async () => {
  // Il tipo decide l'icona e il testo mostrati: una stringa libera qui
  // significherebbe una riga che il frontend non sa disegnare.
  const response = await post(alice, { label: 'Assegno', type: 'CHEQUE' });

  expect(response.statusCode).toBe(400);
  expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
});
