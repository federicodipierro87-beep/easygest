import { randomUUID } from 'node:crypto';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';

/**
 * Le rotte della campanella.
 *
 * Corto di proposito, come gli altri file delle rotte: la paginazione è
 * verificata altrove. Qui restano le cose che riguardano solo le notifiche —
 * l'isolamento fra utenti sul conteggio, che è la rotta più interrogata di
 * tutta l'applicazione, e il fatto che segnare letta due volte non sposti
 * l'istante della prima.
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
      email: `notifiche-${randomUUID()}@easygest.test`,
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

interface NotificationBody {
  id: string;
  kind: string;
  title: string;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
}

interface PaginatedBody {
  items: NotificationBody[];
  total: number;
}

/** Annotato per la stessa ragione degli altri file: `inject` è sovraccaricata. */
async function get(who: typeof alice, url: string): Promise<LightMyRequestResponse> {
  return await app.inject({ method: 'GET', url, headers: who.auth });
}

async function post(who: typeof alice, url: string): Promise<LightMyRequestResponse> {
  return await app.inject({ method: 'POST', url, headers: who.auth });
}

async function aNotification(
  who: typeof alice,
  options: { title?: string; readAt?: Date | null; entityType?: string | null } = {},
): Promise<string> {
  const row = await app.prisma.notification.create({
    data: {
      userId: who.id,
      kind: 'EXPENSE_DUE',
      title: options.title ?? 'Hosting scade fra 7 giorni',
      body: 'Hosting, 122,00 €',
      entityType: options.entityType === undefined ? 'occurrence' : options.entityType,
      readAt: options.readAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  [alice, bob] = await Promise.all([createUser(), createUser()]);
});

afterEach(async () => {
  await app.prisma.notification.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  await app.close();
});

it('non risponde a chi non ha una sessione', async () => {
  const response = await app.inject({ method: 'GET', url: '/notifications/unread-count' });
  expect(response.statusCode).toBe(401);
});

it('conta solo le non lette di chi chiede', async () => {
  await aNotification(alice);
  await aNotification(alice, { readAt: new Date() });
  await aNotification(bob);

  const response = await get(alice, '/notifications/unread-count');
  expect(response.statusCode).toBe(200);
  expect(response.json<{ count: number }>().count).toBe(1);
});

it('elenca dalla pi\u00f9 recente e sa filtrare le non lette', async () => {
  await aNotification(alice, { title: 'Prima', readAt: new Date() });
  await aNotification(alice, { title: 'Seconda' });

  const all = await get(alice, '/notifications');
  expect(all.json<PaginatedBody>().total).toBe(2);
  expect(all.json<PaginatedBody>().items[0]?.title).toBe('Seconda');

  const unread = await get(alice, '/notifications?unread=true');
  const body = unread.json<PaginatedBody>();
  expect(body.total).toBe(1);
  expect(body.items[0]?.title).toBe('Seconda');
});

it('segnare letta due volte non sposta l\u2019istante della prima', async () => {
  // La seconda chiamata è la stessa riga già letta, di solito perché il
  // popover si è riaperto: riscrivere `readAt` cancellerebbe l'unica
  // informazione che il campo porta.
  const id = await aNotification(alice);

  const first = await post(alice, `/notifications/${id}/read`);
  expect(first.statusCode).toBe(200);
  const readAt = first.json<NotificationBody>().readAt;
  expect(readAt).not.toBeNull();

  const second = await post(alice, `/notifications/${id}/read`);
  expect(second.json<NotificationBody>().readAt).toBe(readAt);
});

it('non fa leggere la notifica di un altro', async () => {
  // 404 e non 403: rispondere «esiste ma non è tua» direbbe a un estraneo che
  // quell'identificatore è valido.
  const id = await aNotification(bob);

  const response = await post(alice, `/notifications/${id}/read`);
  expect(response.statusCode).toBe(404);

  const row = await app.prisma.notification.findUniqueOrThrow({
    where: { id },
    select: { readAt: true },
  });
  expect(row.readAt).toBeNull();
});

it('svuota il badge senza toccare quello di un altro', async () => {
  await aNotification(alice);
  await aNotification(alice);
  await aNotification(bob);

  const response = await post(alice, '/notifications/read-all');
  expect(response.json<{ updated: number }>().updated).toBe(2);

  expect((await get(alice, '/notifications/unread-count')).json<{ count: number }>().count).toBe(0);
  expect((await get(bob, '/notifications/unread-count')).json<{ count: number }>().count).toBe(1);
});

it('non inventa un link da un entityType che non riconosce', async () => {
  // La colonna non è un enum — punta a tabelle diverse — quindi un valore
  // scritto da una versione futura arriverebbe qui come stringa qualsiasi.
  // Meglio nullo, che manda alle scadenze, di un link rotto.
  await aNotification(alice, { entityType: 'documento' });

  const body = (await get(alice, '/notifications')).json<PaginatedBody>();
  expect(body.items[0]?.entityType).toBeNull();
});
