import { createHash, randomUUID } from 'node:crypto';

import {
  DOCUMENT_ERROR_CODES,
  type Document,
  type DocumentUploadTicket,
  type Paginated,
} from '@easygest/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';
import type { MemoryStorage } from '../storage';

/**
 * L'archivio in due tempi: biglietto, caricamento, registrazione.
 *
 * Il caricamento vero lo fa il browser sul bucket; qui lo fa `storage.put`,
 * e quello che si prova è ciò che sta intorno — che la registrazione rifiuti un
 * file mai arrivato o una chiave altrui, che la ricerca trovi le parole intere
 * e i pezzi, che cancellando sparisca anche il file.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DOCUMENT_MAX_BYTES: '1000',
});

let app: FastifyInstance;
let storage: MemoryStorage;
let alice: TestUser;
let bob: TestUser;

interface TestUser {
  id: string;
  auth: { authorization: string };
}

interface ErrorBody {
  error: { code: string; details?: unknown };
}

async function createUser(): Promise<TestUser> {
  const user = await app.prisma.user.create({
    data: {
      email: `doc-${randomUUID()}@easygest.test`,
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

const fileOf = (content: string) => {
  const bytes = Buffer.from(content);
  return {
    bytes,
    fileName: 'fattura.pdf',
    mimeType: 'application/pdf' as const,
    sizeBytes: bytes.length,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

function ticket(user: TestUser, file: ReturnType<typeof fileOf>) {
  const { bytes: _bytes, ...announced } = file;
  return app.inject({
    method: 'POST',
    url: '/documents/uploads',
    headers: user.auth,
    payload: announced,
  });
}

function register(
  user: TestUser,
  file: ReturnType<typeof fileOf>,
  storageKey: string,
  document: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  const { bytes: _bytes, ...announced } = file;
  return app.inject({
    method: 'POST',
    url: '/documents',
    headers: user.auth,
    payload: {
      document: { kind: 'INVOICE_PASSIVE', title: 'Fattura', issueDate: '2026-03-15', ...document },
      file: { ...announced, storageKey },
    },
  });
}

/** Il giro completo, come lo fa il browser. */
async function upload(
  user: TestUser,
  content: string,
  document: Record<string, unknown> = {},
): Promise<Document> {
  const file = fileOf(content);
  const { storageKey } = (await ticket(user, file)).json<DocumentUploadTicket>();
  storage.put(storageKey, file.bytes);
  const response = await register(user, file, storageKey, document);
  expect(response.statusCode).toBe(201);
  return response.json<Document>();
}

async function search(user: TestUser, query: string): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/documents?${query}`,
    headers: user.auth,
  });
  expect(response.statusCode).toBe(200);
  return response.json<Paginated<Document>>().items.map((d) => d.title);
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  storage = app.storage as MemoryStorage;
  alice = await createUser();
  bob = await createUser();
});

afterEach(async () => {
  await app.prisma.document.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
  storage.objects.clear();
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  await app.close();
});

describe('caricamento', () => {
  it('senza credenziali non si chiede nemmeno dove caricare', async () => {
    const response = await app.inject({ method: 'POST', url: '/documents/uploads', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('dà una chiave sotto il prefisso dell’utente e non scrive niente', async () => {
    const response = await ticket(alice, fileOf('%PDF uno'));
    expect(response.statusCode).toBe(201);
    const body = response.json<DocumentUploadTicket>();
    expect(body.storageKey.startsWith(`documents/${alice.id}/`)).toBe(true);
    expect(body.upload.method).toBe('PUT');
    expect(await app.prisma.document.count({ where: { userId: alice.id } })).toBe(0);
  });

  it('rifiuta prima di firmare un file oltre il limite', async () => {
    const response = await ticket(alice, fileOf('x'.repeat(1001)));
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.code).toBe(DOCUMENT_ERROR_CODES.fileTooLarge);
  });

  it('rifiuta un tipo di file fuori elenco', async () => {
    const response = await ticket(alice, { ...fileOf('<html>'), mimeType: 'text/html' as never });
    expect(response.statusCode).toBe(400);
  });

  it('avvisa di un doppione, senza impedirlo', async () => {
    // Lo stesso PDF può servire due volte: è un avviso, non un rifiuto.
    const first = await upload(alice, '%PDF stesso contenuto', { title: 'Contratto Aruba' });
    const body = (
      await ticket(alice, fileOf('%PDF stesso contenuto'))
    ).json<DocumentUploadTicket>();
    expect(body.duplicates).toEqual([
      expect.objectContaining({ id: first.id, title: 'Contratto Aruba' }),
    ]);

    // Un altro utente con lo stesso file non vede i documenti di Alice.
    const other = (await ticket(bob, fileOf('%PDF stesso contenuto'))).json<DocumentUploadTicket>();
    expect(other.duplicates).toEqual([]);
  });
});

describe('registrazione', () => {
  it('registra il documento quando il file c’è', async () => {
    const document = await upload(alice, '%PDF fattura', {
      number: 'FPR 12/26',
      grossCents: 12_200,
    });
    expect(document.fileName).toBe('fattura.pdf');
    expect(document.number).toBe('FPR 12/26');
    expect(document.grossCents).toBe(12_200);
    expect(document.issueDate).toBe('2026-03-15');
  });

  it('rifiuta la registrazione se il caricamento non è mai arrivato', async () => {
    const file = fileOf('%PDF perso per strada');
    const { storageKey } = (await ticket(alice, file)).json<DocumentUploadTicket>();
    const response = await register(alice, file, storageKey);
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.code).toBe(DOCUMENT_ERROR_CODES.uploadMissing);
  });

  it('rifiuta un file che non ha la dimensione annunciata', async () => {
    const file = fileOf('%PDF originale');
    const { storageKey } = (await ticket(alice, file)).json<DocumentUploadTicket>();
    storage.put(storageKey, '%PDF un altro file più lungo');
    const response = await register(alice, file, storageKey);
    expect(response.json<ErrorBody>().error.code).toBe(DOCUMENT_ERROR_CODES.uploadMismatch);
  });

  it('non lascia registrare il file caricato da un altro', async () => {
    // La chiave di Bob esiste davvero sullo storage: la risposta è la stessa
    // di una chiave inventata, per non dire a Alice che quella è buona.
    const file = fileOf('%PDF di Bob');
    const { storageKey } = (await ticket(bob, file)).json<DocumentUploadTicket>();
    storage.put(storageKey, file.bytes);
    const response = await register(alice, file, storageKey);
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.code).toBe(DOCUMENT_ERROR_CODES.uploadMissing);
  });

  it('non registra due volte lo stesso caricamento', async () => {
    const file = fileOf('%PDF doppio clic');
    const { storageKey } = (await ticket(alice, file)).json<DocumentUploadTicket>();
    storage.put(storageKey, file.bytes);
    expect((await register(alice, file, storageKey)).statusCode).toBe(201);
    expect((await register(alice, file, storageKey)).statusCode).toBe(409);
  });

  it('non lascia attribuire un documento al cliente di un altro', async () => {
    const client = await app.prisma.client.create({
      data: { userId: bob.id, name: `Cliente di Bob ${randomUUID()}` },
    });
    const file = fileOf('%PDF cliente altrui');
    const { storageKey } = (await ticket(alice, file)).json<DocumentUploadTicket>();
    storage.put(storageKey, file.bytes);
    const response = await register(alice, file, storageKey, {
      kind: 'INVOICE_ACTIVE',
      clientId: client.id,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details).toEqual({ fields: ['clientId'] });
    await app.prisma.client.delete({ where: { id: client.id } });
  });

  it('non accetta una fattura emessa intestata a un fornitore', async () => {
    const file = fileOf('%PDF controparte');
    const { storageKey } = (await ticket(alice, file)).json<DocumentUploadTicket>();
    storage.put(storageKey, file.bytes);
    const response = await register(alice, file, storageKey, {
      kind: 'INVOICE_ACTIVE',
      vendorId: 'qualunque',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('ricerca', () => {
  it('trova le parole intere anche flesse, e i pezzi di parola', async () => {
    await upload(alice, '%PDF a', { title: 'Rinnovo dominio Aruba', notes: 'Pagate con la carta' });
    await upload(alice, '%PDF b', { title: 'F24 saldo INPS', kind: 'F24' });
    await upload(alice, '%PDF c', { title: 'Contratto hosting', number: 'CT-2026-004' });

    // Full-text: «pagata» trova «pagate» nelle note.
    expect(await search(alice, 'q=pagata')).toEqual(['Rinnovo dominio Aruba']);
    // Trigram: un pezzo di parola, che in un tsvector non c'è.
    expect(await search(alice, 'q=arub')).toEqual(['Rinnovo dominio Aruba']);
    // Il numero del documento.
    expect(await search(alice, 'q=2026-004')).toEqual(['Contratto hosting']);
    // I documenti degli altri non si trovano, nemmeno cercandoli per nome.
    expect(await search(bob, 'q=aruba')).toEqual([]);
  });

  it('prende alla lettera i caratteri jolly', async () => {
    await upload(alice, '%PDF d', { title: 'Sconto 100% primo anno' });
    await upload(alice, '%PDF e', { title: 'Sconto 1000 euro' });
    expect(await search(alice, `q=${encodeURIComponent('100%')}`)).toEqual([
      'Sconto 100% primo anno',
    ]);
  });

  it('combina la ricerca con i filtri', async () => {
    await upload(alice, '%PDF f', { title: 'Fattura Aruba marzo', issueDate: '2026-03-01' });
    await upload(alice, '%PDF g', { title: 'Fattura Aruba aprile', issueDate: '2026-04-01' });
    expect(await search(alice, 'q=aruba&from=2026-04-01')).toEqual(['Fattura Aruba aprile']);
  });

  it('filtra per tipo, per etichetta e ordina per data dalla più recente', async () => {
    await upload(alice, '%PDF h', { title: 'Vecchia', issueDate: '2025-01-01', tags: ['INPS'] });
    await upload(alice, '%PDF i', {
      title: 'Nuova',
      issueDate: '2026-01-01',
      tags: ['inps', 'saldo'],
    });
    await upload(alice, '%PDF j', { title: 'Contratto', kind: 'CONTRACT' });
    expect(await search(alice, 'kind=INVOICE_PASSIVE')).toEqual(['Nuova', 'Vecchia']);
    expect(await search(alice, 'tag=inps')).toEqual(['Nuova', 'Vecchia']);
    expect(await search(alice, 'tag=saldo')).toEqual(['Nuova']);
  });
});

describe('ordinamento', () => {
  it('per scadenza mette in fondo chi non ne ha, in tutte e due le direzioni', async () => {
    await upload(alice, '%PDF o', { title: 'Senza scadenza' });
    await upload(alice, '%PDF p', { title: 'Maggio', dueDate: '2026-05-16' });
    await upload(alice, '%PDF q', { title: 'Giugno', dueDate: '2026-06-16' });
    expect(await search(alice, 'sort=dueDate&direction=asc')).toEqual([
      'Maggio',
      'Giugno',
      'Senza scadenza',
    ]);
    expect(await search(alice, 'sort=dueDate&direction=desc')).toEqual([
      'Giugno',
      'Maggio',
      'Senza scadenza',
    ]);
  });
});

describe('modifica, download e cancellazione', () => {
  it('modifica i metadati senza toccare il file', async () => {
    const document = await upload(alice, '%PDF k');
    const response = await app.inject({
      method: 'PUT',
      url: `/documents/${document.id}`,
      headers: alice.auth,
      payload: { kind: 'RECEIPT', title: 'Ricevuta', issueDate: '2026-05-01' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Document>()).toMatchObject({
      kind: 'RECEIPT',
      title: 'Ricevuta',
      fileName: 'fattura.pdf',
    });
  });

  it('dà un URL firmato con il nome del file, solo al proprietario', async () => {
    const document = await upload(alice, '%PDF l');
    const own = await app.inject({
      method: 'GET',
      url: `/documents/${document.id}/download?disposition=attachment`,
      headers: alice.auth,
    });
    expect(own.json<{ url: string }>().url).toContain('disposition=attachment');
    expect(own.json<{ url: string }>().url).toContain('fattura.pdf');

    const other = await app.inject({
      method: 'GET',
      url: `/documents/${document.id}/download`,
      headers: bob.auth,
    });
    expect(other.statusCode).toBe(404);
  });

  it('cancellando porta via anche il file', async () => {
    const document = await upload(alice, '%PDF m');
    expect(storage.objects.size).toBe(1);
    const response = await app.inject({
      method: 'DELETE',
      url: `/documents/${document.id}`,
      headers: alice.auth,
    });
    expect(response.statusCode).toBe(204);
    expect(storage.objects.size).toBe(0);
  });

  it('non cancella il documento di un altro', async () => {
    const document = await upload(alice, '%PDF n');
    const response = await app.inject({
      method: 'DELETE',
      url: `/documents/${document.id}`,
      headers: bob.auth,
    });
    expect(response.statusCode).toBe(404);
    expect(storage.objects.size).toBe(1);
  });
});
