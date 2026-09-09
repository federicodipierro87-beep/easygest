import { randomUUID } from 'node:crypto';

import { RESOURCE_ERROR_CODES } from '@easygest/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * Le categorie condividono con clienti e fornitori la meccanica degli elenchi,
 * già verificata in `clients.test.ts`: qui si prova solo ciò che è loro.
 *
 * Sono tre cose, e sono tutte e tre invisibili se sbagliate. L'ambito filtra
 * per uso e non per uguaglianza, l'ordine lo decide il server e non il corpo
 * della richiesta, e le categorie di sistema si modificano ma non si
 * cancellano — una regola che vive in due punti diversi del codice e che una
 * `PUT` scritta a mano proverebbe ad aggirare.
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

interface CategoryBody {
  id: string;
  name: string;
  scope: string;
  color: string | null;
  icon: string | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  expenseCount: number;
  documentCount: number;
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
    url: '/categories',
    headers: who.auth,
    payload: body,
  });
}

async function createCategory(
  who: typeof alice,
  body: Record<string, unknown>,
): Promise<CategoryBody> {
  const response = await post(who, body);
  expect(response.statusCode).toBe(201);
  return response.json<CategoryBody>();
}

async function list(who: typeof alice, query = ''): Promise<CategoryBody[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/categories${query}`,
    headers: who.auth,
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ items: CategoryBody[] }>().items;
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  [alice, bob] = await Promise.all([createUser(), createUser()]);
});

afterEach(async () => {
  const where = { userId: { in: [alice.id, bob.id] } };
  await app.prisma.expense.deleteMany({ where });
  await app.prisma.document.deleteMany({ where });
  await app.prisma.category.deleteMany({ where });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  await app.close();
});

it('include le categorie «BOTH» quando si filtra per un ambito', async () => {
  // È il difetto che questo filtro esiste per non avere: chiedere
  // `scope = EXPENSE` e basta darebbe un menù a tendina a cui mancano metà
  // delle voci, senza che niente sembri rotto.
  await createCategory(alice, { name: 'Solo spese', scope: 'EXPENSE' });
  await createCategory(alice, { name: 'Solo documenti', scope: 'DOCUMENT' });
  await createCategory(alice, { name: 'Tutte e due', scope: 'BOTH' });

  const usable = await list(alice, '?usableFor=EXPENSE&sort=name');

  expect(usable.map((category) => category.name)).toEqual(['Solo spese', 'Tutte e due']);
});

it('mette le nuove categorie in fondo', async () => {
  // `sortOrder` non arriva dal corpo: lo assegna il server, che è l'unico a
  // sapere cosa c'è già. Se restassero tutte a zero, l'ordine manuale sarebbe
  // l'ordine di inserimento mascherato da ordine scelto.
  const first = await createCategory(alice, { name: 'Prima' });
  const second = await createCategory(alice, { name: 'Seconda' });

  expect(first.sortOrder).toBe(0);
  expect(second.sortOrder).toBe(1);
});

it('non lascia che una richiesta si assegni un ordine o il flag di sistema', async () => {
  // Lo schema è `strictObject`: i due campi che il server si riserva non sono
  // ignorati, sono un errore. È ciò che impedisce a una `PUT` costruita a mano
  // di togliersi da sola il blocco alla cancellazione.
  const withFlag = await post(alice, { name: 'Furba', isSystem: true });
  expect(withFlag.statusCode).toBe(400);
  expect(withFlag.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');

  const withOrder = await post(alice, { name: 'Impaziente', sortOrder: 0 });
  expect(withOrder.statusCode).toBe(400);
});

it('rinomina una categoria di sistema ma non la cancella', async () => {
  // Le due metà della stessa decisione. Il seed ricrea per nome, quindi la
  // cancellazione riuscirebbe e si disferebbe da sola al prossimo avvio; il
  // nome e il colore invece sono modifiche che il seed non tocca, e vietarle
  // sarebbe una limitazione senza motivo.
  const system = await app.prisma.category.create({
    data: { userId: alice.id, name: 'Hosting e server', isSystem: true, sortOrder: 0 },
    select: { id: true },
  });

  const renamed = await app.inject({
    method: 'PUT',
    url: `/categories/${system.id}`,
    headers: alice.auth,
    payload: { name: 'Server e hosting', color: '#2563EB' },
  });
  expect(renamed.statusCode).toBe(200);
  const body = renamed.json<CategoryBody>();
  expect(body.name).toBe('Server e hosting');
  // Il colore passa dalla normalizzazione dello schema anche in aggiornamento.
  expect(body.color).toBe('#2563eb');
  expect(body.isSystem).toBe(true);

  const deleted = await app.inject({
    method: 'DELETE',
    url: `/categories/${system.id}`,
    headers: alice.auth,
  });
  expect(deleted.statusCode).toBe(409);
  expect(deleted.json<ErrorBody>().error.code).toBe(RESOURCE_ERROR_CODES.systemManaged);
});

it('rifiuta di cancellare una categoria usata da una spesa o da un documento', async () => {
  // `onDelete: SetNull` non impedisce la cancellazione: la lascia riuscire e
  // toglie l'etichetta allo storico. Il conteggio nei dettagli serve a dire
  // dove andare a guardare prima di archiviare.
  const category = await createCategory(alice, { name: 'Con Storico' });
  await app.prisma.expense.create({
    data: {
      userId: alice.id,
      categoryId: category.id,
      name: 'Dominio',
      netCents: 1_500,
      grossCents: 1_830,
      startDate: new Date('2026-01-01'),
    },
  });
  await app.prisma.document.create({
    data: {
      userId: alice.id,
      categoryId: category.id,
      kind: 'INVOICE_PASSIVE',
      title: 'Fattura Aruba',
      issueDate: new Date('2026-01-01'),
      storageKey: `test/${randomUUID()}`,
      fileName: 'fattura.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1_024,
    },
  });

  const response = await app.inject({
    method: 'DELETE',
    url: `/categories/${category.id}`,
    headers: alice.auth,
  });

  expect(response.statusCode).toBe(409);
  const body = response.json<ErrorBody>();
  expect(body.error.code).toBe(RESOURCE_ERROR_CODES.inUse);
  expect(body.error.details).toEqual({ expenses: 1, documents: 1 });
});

it('archivia una categoria invece di cancellarla, e la toglie dagli elenchi', async () => {
  // L'archiviazione è la via d'uscita che i due rifiuti indicano: se non
  // togliesse davvero la voce dagli elenchi, il messaggio d'errore starebbe
  // consigliando un'operazione inutile.
  const category = await createCategory(alice, { name: 'Vecchia' });

  const archived = await app.inject({
    method: 'PUT',
    url: `/categories/${category.id}`,
    headers: alice.auth,
    payload: { name: 'Vecchia', isActive: false },
  });
  expect(archived.statusCode).toBe(200);

  expect(await list(alice)).toHaveLength(0);
  expect(await list(alice, '?archived=only')).toHaveLength(1);
  expect(await list(alice, '?archived=include')).toHaveLength(1);
});

it('non lascia vedere né toccare le categorie di un altro utente', async () => {
  const ofBob = await createCategory(bob, { name: 'Riservata' });

  expect(await list(alice)).toHaveLength(0);

  const read = await app.inject({
    method: 'GET',
    url: `/categories/${ofBob.id}`,
    headers: alice.auth,
  });
  expect(read.statusCode).toBe(404);

  // Il nome è unico per utente, non globalmente: la stessa categoria deve
  // poter esistere per due utenti diversi.
  const sameName = await post(alice, { name: 'Riservata' });
  expect(sameName.statusCode).toBe(201);
});

it('rifiuta due categorie con lo stesso nome per lo stesso utente', async () => {
  await createCategory(alice, { name: 'Domini' });

  const duplicate = await post(alice, { name: 'Domini' });

  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json<ErrorBody>().error.code).toBe(RESOURCE_ERROR_CODES.duplicateName);
});
