import { randomUUID } from 'node:crypto';

import { RESOURCE_ERROR_CODES } from '@easygest/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * Test di integrazione delle rotte dei clienti, contro un PostgreSQL vero.
 *
 * Le regole che contano qui non stanno nel codice delle rotte: stanno nei
 * vincoli del database e nel filtro `userId` di ogni query. Un `@@unique`
 * sbagliato, una `where` che dimentica il proprietario o un `select` che si
 * porta dietro una colonna di troppo sono difetti che un client Prisma finto
 * non vedrebbe mai, perché verificherebbe solo che il codice chiama i metodi
 * che il finto client si aspetta.
 *
 * Due utenti e non uno: metà di ciò che va verificato è che il secondo non
 * riesca a vedere né a toccare i dati del primo, e con un solo utente quella
 * metà non è esprimibile.
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
      // Nessun login passa di qui: il token si firma direttamente, quindi
      // l'hash non deve corrispondere a niente. Firmarlo invece di chiamare
      // `/auth/login` evita anche di consumare il limite di cinque tentativi,
      // che è per indirizzo e non si azzera fra un test e l'altro.
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

interface ClientBody {
  id: string;
  name: string;
  vatNumber: string | null;
  notes: string | null;
  countryCode: string;
  isActive: boolean;
  expenseCount: number;
  documentCount: number;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
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
  return await app.inject({ method: 'POST', url: '/clients', headers: who.auth, payload: body });
}

async function createClient(who: typeof alice, body: Record<string, unknown>): Promise<ClientBody> {
  const response = await post(who, body);
  expect(response.statusCode).toBe(201);
  return response.json<ClientBody>();
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  [alice, bob] = await Promise.all([createUser(), createUser()]);
});

afterEach(async () => {
  // Le spese vanno tolte per prime: sono loro a rendere un cliente
  // incancellabile, ed è esattamente ciò che uno dei test crea apposta.
  const where = { userId: { in: [alice.id, bob.id] } };
  await app.prisma.expense.deleteMany({ where });
  await app.prisma.client.deleteMany({ where });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  await app.close();
});

describe('creazione', () => {
  it('crea un cliente col minimo indispensabile e applica i valori di default', async () => {
    const created = await createClient(alice, { name: 'Studio Rossi' });

    expect(created.name).toBe('Studio Rossi');
    expect(created.countryCode).toBe('IT');
    expect(created.isActive).toBe(true);
    expect(created.vatNumber).toBeNull();
    // I due contatori accompagnano ogni risposta: sono ciò che permette
    // all'interfaccia di sapere che la cancellazione verrà rifiutata senza
    // doverla prima tentare.
    expect(created.expenseCount).toBe(0);
    expect(created.documentCount).toBe(0);
    // `userId` non esce mai: è sempre quello di chi chiama.
    expect(created).not.toHaveProperty('userId');
  });

  it('normalizza la partita IVA e ne verifica la cifra di controllo', async () => {
    const created = await createClient(alice, { name: 'Acme', vatNumber: 'IT 00743110157' });
    expect(created.vatNumber).toBe('00743110157');

    const rejected = await post(alice, { name: 'Beta', vatNumber: '00743110158' });
    expect(rejected.statusCode).toBe(400);
    const body = rejected.json<{ error: { code: string; details: { field: string }[] } }>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.map((detail) => detail.field)).toContain('vatNumber');
  });

  it('rifiuta un campo che non conosce invece di ignorarlo', async () => {
    // Uno schema permissivo lascerebbe cadere `userId` in silenzio. Qui
    // l'utente si vede dire quale campo è di troppo, e un tentativo di
    // scrivere un record a nome di un altro non somiglia a un successo.
    const response = await post(alice, { name: 'Gamma', userId: bob.id });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
  });

  it('rifiuta un nome già usato dallo stesso utente ma non da un altro', async () => {
    await createClient(alice, { name: 'Omonimo' });

    const duplicate = await post(alice, { name: 'Omonimo' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<ErrorBody>().error.code).toBe(RESOURCE_ERROR_CODES.duplicateName);

    // L'unicità è per utente: il nome di un cliente di Alice non può togliere
    // a Bob la possibilità di usarlo.
    const other = await post(bob, { name: 'Omonimo' });
    expect(other.statusCode).toBe(201);
  });
});

describe('elenco', () => {
  it('cerca anche nei codici, non solo nel nome', async () => {
    await createClient(alice, { name: 'Studio Bianchi', vatNumber: '00743110157' });
    await createClient(alice, { name: 'Verdi Srl' });

    // La partita IVA è spesso l'unica cosa riconoscibile su una fattura in
    // mano: se la ricerca guardasse solo il nome non servirebbe a niente.
    const response = await app.inject({
      method: 'GET',
      url: '/clients?q=0074311',
      headers: alice.auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: ClientBody[]; total: number }>();
    expect(body.total).toBe(1);
    expect(body.items[0]?.name).toBe('Studio Bianchi');
  });

  it('nasconde gli archiviati salvo richiesta esplicita', async () => {
    const archived = await createClient(alice, { name: 'Cliente Chiuso' });
    await app.inject({
      method: 'PUT',
      url: `/clients/${archived.id}`,
      headers: alice.auth,
      payload: { name: 'Cliente Chiuso', isActive: false },
    });
    await createClient(alice, { name: 'Cliente Attivo' });

    const listOf = async (archivedFilter: string) => {
      const response = await app.inject({
        method: 'GET',
        url: `/clients?archived=${archivedFilter}`,
        headers: alice.auth,
      });
      return response.json<{ items: ClientBody[]; total: number }>();
    };

    expect((await listOf('exclude')).items.map((item) => item.name)).toEqual(['Cliente Attivo']);
    expect((await listOf('only')).items.map((item) => item.name)).toEqual(['Cliente Chiuso']);
    expect((await listOf('include')).total).toBe(2);
  });

  it('impagina e non mostra i clienti di un altro utente', async () => {
    await createClient(alice, { name: 'Primo' });
    await createClient(alice, { name: 'Secondo' });
    await createClient(bob, { name: 'Di Bob' });

    const response = await app.inject({
      method: 'GET',
      url: '/clients?perPage=1&page=2&sort=name&direction=asc',
      headers: alice.auth,
    });

    const body = response.json<{
      items: ClientBody[];
      page: number;
      total: number;
      totalPages: number;
    }>();
    expect(body.total).toBe(2);
    expect(body.totalPages).toBe(2);
    expect(body.items.map((item) => item.name)).toEqual(['Secondo']);
  });

  it('rifiuta un campo di ordinamento che non è previsto', async () => {
    // L'ordinamento finisce dentro `orderBy` come nome di colonna: se lo
    // schema non lo limitasse a un elenco chiuso, la query string sceglierebbe
    // su quale colonna del modello ordinare.
    const response = await app.inject({
      method: 'GET',
      url: '/clients?sort=notes',
      headers: alice.auth,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('lettura e modifica', () => {
  it('sostituisce il cliente per intero, campi omessi compresi', async () => {
    const created = await createClient(alice, {
      name: 'Con Note',
      notes: 'Da richiamare',
      vatNumber: '00743110157',
    });

    // Il PUT è una sostituzione, non una modifica parziale: `notes` non
    // compare, quindi deve sparire. Se restasse, svuotare un campo dal form
    // sarebbe impossibile.
    const response = await app.inject({
      method: 'PUT',
      url: `/clients/${created.id}`,
      headers: alice.auth,
      payload: { name: 'Con Note', vatNumber: '00743110157' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<ClientBody>().notes).toBeNull();
  });

  it('tratta il cliente di un altro utente come inesistente', async () => {
    const ofBob = await createClient(bob, { name: 'Riservato' });

    // Non 403: rispondere «esiste ma non è tuo» confermerebbe che
    // l'identificativo è buono, cioè trasformerebbe la rotta in un modo per
    // sapere quali id esistono.
    for (const request of [
      { method: 'GET' as const, url: `/clients/${ofBob.id}` },
      {
        method: 'PUT' as const,
        url: `/clients/${ofBob.id}`,
        payload: { name: 'Rinominato' },
      },
      { method: 'DELETE' as const, url: `/clients/${ofBob.id}` },
    ]) {
      const response = await app.inject({ ...request, headers: alice.auth });
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    }

    // E il cliente di Bob è ancora lì, col nome di prima.
    const survived = await app.prisma.client.findUnique({ where: { id: ofBob.id } });
    expect(survived?.name).toBe('Riservato');
  });

  it('chiede il token come tutte le altre rotte', async () => {
    const response = await app.inject({ method: 'GET', url: '/clients' });
    expect(response.statusCode).toBe(401);
  });
});

describe('cancellazione', () => {
  it('cancella un cliente senza storico e libera il nome', async () => {
    const created = await createClient(alice, { name: 'Inserito Per Sbaglio' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/clients/${created.id}`,
      headers: alice.auth,
    });
    expect(deleted.statusCode).toBe(204);

    // Il nome torna disponibile: è la ragione per cui la cancellazione esiste
    // accanto all'archiviazione.
    const again = await post(alice, { name: 'Inserito Per Sbaglio' });
    expect(again.statusCode).toBe(201);
  });

  it('rifiuta di cancellare un cliente con dello storico e dice quanto', async () => {
    const created = await createClient(alice, { name: 'Con Storico' });
    await app.prisma.expense.create({
      data: {
        userId: alice.id,
        clientId: created.id,
        name: 'Hosting',
        netCents: 10_000,
        grossCents: 12_200,
        startDate: new Date('2026-01-01'),
      },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/clients/${created.id}`,
      headers: alice.auth,
    });

    /**
     * La spesa punta al cliente con `onDelete: SetNull`: la cancellazione
     * riuscirebbe senza rompere niente, e staccherebbe in silenzio
     * l'attribuzione di una spesa di tre anni fa. Il 409 è quello che rende
     * visibile la perdita prima che avvenga, e i conteggi nei dettagli dicono
     * dove andare a guardare.
     */
    expect(response.statusCode).toBe(409);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe(RESOURCE_ERROR_CODES.inUse);
    expect(body.error.details).toEqual({ expenses: 1, documents: 0 });

    // E il conteggio si vede anche in lettura, prima di provarci.
    const reread = await app.inject({
      method: 'GET',
      url: `/clients/${created.id}`,
      headers: alice.auth,
    });
    expect(reread.json<ClientBody>().expenseCount).toBe(1);
  });
});
