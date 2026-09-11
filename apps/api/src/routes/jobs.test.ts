import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { type Env, parseEnv } from '../config/env';
import type { JobResult } from '../jobs/types';
import type { Fetcher } from '../services/frankfurter';

/**
 * L'esecuzione manuale dei lavori.
 *
 * Il giro in sé è provato in `jobs/daily.test.ts`; qui resta ciò che si vede
 * solo dalla rotta: che serva una sessione, che un nome inventato sia un 400 e
 * non un 500 a giro avviato, e soprattutto che il giro lanciato da Alice tocchi
 * i dati di Alice e nessun altro — che è l'unica ragione per cui l'endpoint può
 * stare dietro alla sessione invece che dietro a un token di servizio.
 *
 * **Tre richieste in tutto, ed è un vincolo.** La rotta ha un limite di cinque
 * al minuto per client, e `inject` arriva sempre dallo stesso indirizzo: una
 * prova in più qui diventerebbe un 429 e un test rosso che non racconta niente.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

/**
 * La BCE, finta e senza tassi.
 *
 * Una risposta vuota è valida per `frankfurterResponseSchema` e non scrive
 * nessuna riga in `FxRate`. È deliberato: la tabella dei cambi è condivisa, e
 * gli altri file della suite girano in parallelo sullo stesso database. La
 * sincronizzazione vera è provata in `services/frankfurter.test.ts`, che quelle
 * righe le possiede.
 */
const fxFetcher: Fetcher = () => Promise.resolve({ base: 'EUR', date: '2027-03-15', rates: {} });

let app: FastifyInstance;
let alice: { id: string; auth: { authorization: string } };
let bob: { id: string; auth: { authorization: string } };

/** Mezzanotte UTC di `n` giorni fa: le date di calendario stanno lì. */
function daysAgo(n: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n));
}

async function createUser(): Promise<{ id: string; auth: { authorization: string } }> {
  const user = await app.prisma.user.create({
    data: {
      email: `lavori-${randomUUID()}@easygest.test`,
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

/** Una spesa scaduta con rinnovo automatico: lo sweep deve marcarla pagata. */
async function anOverdueExpense(who: typeof alice): Promise<string> {
  const dueDate = daysAgo(5);
  const expense = await app.prisma.expense.create({
    data: {
      userId: who.id,
      name: 'Abbonamento',
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: 12_200,
      currency: 'EUR',
      recurrenceUnit: 'MONTH',
      recurrenceInterval: 1,
      startDate: dueDate,
      status: 'ACTIVE',
      autoRenew: true,
      // `syncOccurrences` non materializza il passato: l'arretrata la scrive il
      // test, come in `jobs/daily.test.ts`.
      occurrences: {
        create: {
          userId: who.id,
          dueDate,
          periodStart: dueDate,
          netCents: 10_000,
          vatRateBp: 2200,
          grossCents: 12_200,
          currency: 'EUR',
          baseGrossCents: 12_200,
        },
      },
    },
    select: { id: true },
  });
  return expense.id;
}

beforeAll(async () => {
  app = await buildApp(env, { fxFetcher });
  await app.ready();
  [alice, bob] = await Promise.all([createUser(), createUser()]);
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  await app.close();
});

it('non lancia niente a chi non ha una sessione', async () => {
  // Il giro scrive: un endpoint che marca pagate delle scadenze non può stare
  // aperto, e non c'è nessun caso d'uso anonimo da preservare.
  const response = await app.inject({ method: 'POST', url: '/jobs/daily/run' });
  expect(response.statusCode).toBe(401);
});

it('rifiuta un lavoro che non esiste invece di avviarlo', async () => {
  // Il nome arriva dal percorso, quindi qualunque stringa raggiunge la rotta:
  // senza lo `z.enum` finirebbe nello `switch` del runner e uscirebbe come 500
  // a metà giro.
  const response = await app.inject({
    method: 'POST',
    url: '/jobs/pulizia/run',
    headers: alice.auth,
  });

  expect(response.statusCode).toBe(400);
  expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
});

it('gira sui dati di chi lo lancia e su nessun altro', async () => {
  // È la premessa dell'intera decisione: l'endpoint non fa nulla che l'utente
  // non possa già fare sui propri dati. Senza il filtro su `userId` marcherebbe
  // pagate le scadenze di tutti, e la protezione con la sola sessione
  // diventerebbe indifendibile.
  const mia = await anOverdueExpense(alice);
  const sua = await anOverdueExpense(bob);

  const response = await app.inject({
    method: 'POST',
    url: '/jobs/daily/run',
    headers: alice.auth,
  });
  const result = response.json<JobResult>();

  expect(response.statusCode).toBe(200);
  expect(result.name).toBe('daily');
  // I contatori sono la risposta alla domanda «funziona in produzione?»: senza
  // di loro il pulsante direbbe soltanto «fatto».
  expect(result.counters.markedPaid).toBeGreaterThan(0);
  expect(result.counters.failures).toBe(0);

  expect(await app.prisma.expenseOccurrence.count({ where: { expenseId: mia } })).toBeGreaterThan(
    1,
  );
  expect(
    await app.prisma.expenseOccurrence.count({ where: { expenseId: mia, status: 'PAID' } }),
  ).toBe(1);
  expect(
    await app.prisma.expenseOccurrence.count({ where: { expenseId: sua, status: 'PLANNED' } }),
  ).toBe(1);
  expect(await app.prisma.notification.count({ where: { userId: bob.id } })).toBe(0);
});
