import { randomUUID } from 'node:crypto';

import { RESOURCE_ERROR_CODES } from '@easygest/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * Le rotte dei fornitori sono la copia di quelle dei clienti, e questo file è
 * deliberatamente più corto del suo gemello.
 *
 * Il comportamento comune — impaginazione, filtri, formato degli errori — è già
 * verificato in `clients.test.ts` e ripeterlo qui non aggiungerebbe copertura,
 * aggiungerebbe solo un secondo posto da aggiornare. Quello che invece va
 * verificato due volte è ciò che una copia sbaglia in silenzio: una query
 * rimasta su `client`, un campo cercato che non è quello del modello giusto.
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

interface VendorBody {
  id: string;
  name: string;
  website: string | null;
  portalUrl: string | null;
  accountRef: string | null;
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
  return await app.inject({ method: 'POST', url: '/vendors', headers: who.auth, payload: body });
}

async function createVendor(who: typeof alice, body: Record<string, unknown>): Promise<VendorBody> {
  const response = await post(who, body);
  expect(response.statusCode).toBe(201);
  return response.json<VendorBody>();
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  [alice, bob] = await Promise.all([createUser(), createUser()]);
});

afterEach(async () => {
  const where = { userId: { in: [alice.id, bob.id] } };
  await app.prisma.expense.deleteMany({ where });
  await app.prisma.vendor.deleteMany({ where });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  await app.close();
});

it('completa e normalizza gli indirizzi web', async () => {
  // Un fornitore lo si inserisce copiando il dominio da una fattura, non
  // scrivendo «https://» a mano. Lo schema completa lo schema mancante e
  // normalizza l'host, così due righe uguali non sembrano diverse.
  const created = await createVendor(alice, {
    name: 'Aruba',
    website: 'Aruba.IT',
    portalUrl: 'https://admin.aruba.it/pannello',
  });

  expect(created.website).toBe('https://aruba.it/');
  expect(created.portalUrl).toBe('https://admin.aruba.it/pannello');
});

it('rifiuta un indirizzo che non è http', async () => {
  // `javascript:` finirebbe in un `href` della pagina dei fornitori: è un
  // campo di testo che diventa un collegamento cliccabile, quindi il filtro
  // sta nello schema e non nella resa.
  const response = await post(alice, { name: 'Sospetto', website: 'javascript:alert(1)' });

  expect(response.statusCode).toBe(400);
  expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
});

it('cerca nel numero cliente, che è il campo con cui un fornitore si ritrova', async () => {
  await createVendor(alice, { name: 'Register', accountRef: 'AB-99120' });
  await createVendor(alice, { name: 'Netlify' });

  // Una email di rinnovo riporta il numero di contratto e spesso nemmeno il
  // nome commerciale con cui il fornitore è stato salvato.
  const response = await app.inject({
    method: 'GET',
    url: '/vendors?q=99120',
    headers: alice.auth,
  });

  const body = response.json<{ items: VendorBody[]; total: number }>();
  expect(body.total).toBe(1);
  expect(body.items[0]?.name).toBe('Register');
});

it('non lascia vedere né toccare i fornitori di un altro utente', async () => {
  const ofBob = await createVendor(bob, { name: 'Riservato' });

  const list = await app.inject({ method: 'GET', url: '/vendors', headers: alice.auth });
  expect(list.json<{ total: number }>().total).toBe(0);

  const read = await app.inject({
    method: 'GET',
    url: `/vendors/${ofBob.id}`,
    headers: alice.auth,
  });
  expect(read.statusCode).toBe(404);
});

it('rifiuta di cancellare un fornitore con dello storico', async () => {
  const created = await createVendor(alice, { name: 'Con Storico' });
  await app.prisma.expense.create({
    data: {
      userId: alice.id,
      vendorId: created.id,
      name: 'Dominio',
      netCents: 1_500,
      grossCents: 1_830,
      startDate: new Date('2026-01-01'),
    },
  });

  const response = await app.inject({
    method: 'DELETE',
    url: `/vendors/${created.id}`,
    headers: alice.auth,
  });

  expect(response.statusCode).toBe(409);
  const body = response.json<ErrorBody>();
  expect(body.error.code).toBe(RESOURCE_ERROR_CODES.inUse);
  expect(body.error.details).toEqual({ expenses: 1, documents: 0 });
});

it('rifiuta un campo che appartiene ai clienti e non ai fornitori', async () => {
  // I due schemi non sono lo stesso schema con nomi diversi: un fornitore non
  // ha il codice destinatario, e chiederglielo è un errore da segnalare, non
  // un campo da ignorare.
  const response = await post(alice, { name: 'Confuso', sdiCode: 'ABC123' });

  expect(response.statusCode).toBe(400);
  expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
});
