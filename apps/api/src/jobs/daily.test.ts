import { randomUUID } from 'node:crypto';

import { formatIsoDate, parseIsoDate } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { type Env, parseEnv } from '../config/env';
import { type MemoryMailer, createMemoryMailer } from '../mail';
import type { Fetcher } from '../services/frankfurter';
import { runDailyJob } from './daily';
import { runJob } from './runner';
import type { JobContext } from './types';

/**
 * Il giro intero, su un database vero.
 *
 * È il test che vale la fase, e prova una cosa sola che nessun altro può
 * provare: che **rifare il giro non rifà niente**. L'idempotenza qui non è una
 * proprietà elegante, è la premessa di tre decisioni prese altrove — il
 * recupero a ogni avvio, il pulsante «Esegui adesso», e il non tenere un
 * registro delle esecuzioni. Se cade questa, cadono quelle.
 *
 * Niente rete: il `fetcher` dei cambi è un parametro, e il mailer è quello in
 * memoria. Niente `vi.useFakeTimers()`: `now` è un parametro.
 *
 * Il giro è ristretto a `userId`. Senza, toccherebbe gli utenti di prova degli
 * altri file, che girano in parallelo in un worker diverso sullo stesso
 * database.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

let app: FastifyInstance;
let userId: string;
let email: string;

const d = (value: string): Date => {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error(`Data di test non valida: ${value}`);
  return parsed;
};

/** Un lunedì, così il riepilogo settimanale cade nello stesso giro. */
const TODAY = d('2027-03-15');

/**
 * La BCE, finta.
 *
 * Restituisce la forma che `frankfurterResponseSchema` accetta. Le valute sono
 * quelle seguite; i tassi sono inventati e non contano, perché nessuna spesa
 * di questo file è in valuta.
 */
const fetcher: Fetcher = () =>
  Promise.resolve({
    base: 'EUR',
    date: formatIsoDate(TODAY),
    rates: { USD: 1.09, GBP: 0.85, CHF: 0.96 },
  });

function contextWith(mailer: MemoryMailer, now = TODAY): JobContext {
  return {
    prisma: app.prisma,
    mailer,
    log: app.log,
    now,
    baseUrl: 'http://localhost:5173',
    notificationRetentionDays: 180,
    fetcher,
  };
}

async function run(mailer: MemoryMailer, now = TODAY): ReturnType<typeof runDailyJob> {
  return runDailyJob(contextWith(mailer, now), { userId });
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  email = `daily-${randomUUID()}@easygest.test`;
  const user = await app.prisma.user.create({
    data: {
      email,
      displayName: 'Utente di prova',
      passwordHash: 'non-usato',
      // `timezone` di default è quello dello schema: il giro calcola il proprio
      // «oggi» da qui, non da `CRON_TIMEZONE`.
      settings: { create: {} },
    },
    select: { id: true },
  });
  userId = user.id;
});

afterEach(async () => {
  await app.prisma.reminderLog.deleteMany({ where: { userId } });
  await app.prisma.notification.deleteMany({ where: { userId } });
  await app.prisma.expense.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await app.prisma.fxRate.deleteMany({ where: { date: TODAY, source: 'frankfurter' } });
  await app.prisma.user.delete({ where: { id: userId } });
  await app.close();
});

/** Una spesa mensile che parte dalla data data. Lo sweep fa il resto. */
async function anExpense(options: {
  name: string;
  startDate: Date;
  autoRenew?: boolean;
  cancellationNoticeDays?: number | null;
}): Promise<string> {
  const expense = await app.prisma.expense.create({
    data: {
      userId,
      name: options.name,
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: 12_200,
      currency: 'EUR',
      recurrenceUnit: 'MONTH',
      recurrenceInterval: 1,
      startDate: options.startDate,
      status: 'ACTIVE',
      autoRenew: options.autoRenew ?? false,
      cancellationNoticeDays: options.cancellationNoticeDays ?? null,
    },
    select: { id: true },
  });
  return expense.id;
}

describe('il giro giornaliero', () => {
  it('sincronizza i cambi, materializza le scadenze e avvisa, in quest\u2019ordine', async () => {
    // L'ordine è il punto: la scadenza del 22 marzo non esiste finché lo sweep
    // non la scrive, e se i promemoria girassero prima non la vedrebbero.
    await anExpense({ name: 'Hosting', startDate: d('2027-03-22') });

    const mailer = createMemoryMailer();
    const result = await run(mailer);

    expect(result.name).toBe('daily');
    expect(result.counters.occurrencesSynced).toBeGreaterThan(0);
    expect(result.counters.remindersPlanned).toBeGreaterThan(0);
    expect(result.counters.emailsSent).toBeGreaterThan(0);
    expect(result.counters.failures).toBe(0);
    expect(mailer.sent.some((message) => message.text.includes('Hosting'))).toBe(true);
  });

  it('rifatto con gli stessi argomenti non rimanda niente', async () => {
    // L'idempotenza in due righe. È la premessa del recupero all'avvio: tre
    // deploy in un pomeriggio producono tre giri e zero email in più.
    await anExpense({ name: 'Hosting', startDate: d('2027-03-22') });

    const mailer = createMemoryMailer();
    await run(mailer);
    const before = mailer.sent.length;
    const second = await run(mailer);

    expect(mailer.sent).toHaveLength(before);
    expect(second.counters.emailsSent).toBe(0);
    expect(second.counters.notificationsCreated).toBe(0);
    expect(second.counters.occurrencesSynced).toBe(0);
    expect(second.counters.failures).toBe(0);
  });

  it('marca pagate le scadute con rinnovo automatico e lo dice in-app', async () => {
    const expenseId = await anExpense({
      name: 'Abbonamento',
      startDate: d('2027-02-15'),
      autoRenew: true,
    });
    // `syncOccurrences` non materializza il passato: l'arretrata la scrive il
    // test, come in `sweep.test.ts`.
    await app.prisma.expenseOccurrence.create({
      data: {
        userId,
        expenseId,
        dueDate: d('2027-02-15'),
        periodStart: d('2027-02-15'),
        netCents: 10_000,
        vatRateBp: 2200,
        grossCents: 12_200,
        currency: 'EUR',
        baseGrossCents: 12_200,
      },
    });

    const mailer = createMemoryMailer();
    const result = await run(mailer);

    expect(result.counters.markedPaid).toBe(1);

    const paid = await app.prisma.expenseOccurrence.findFirstOrThrow({
      where: { expenseId, status: 'PAID' },
      select: { dueDate: true, paidAt: true, confirmedAt: true },
    });
    // `paidAt = dueDate`: il denaro è uscito il giorno della scadenza, non il
    // giorno in cui il cron se n'è accorto.
    expect(paid.paidAt === null ? null : formatIsoDate(paid.paidAt)).toBe('2027-02-15');
    // `confirmedAt` nullo: nessuno ha ancora guardato l'importo, ed è il modo
    // in cui un aumento di prezzo salta all'occhio.
    expect(paid.confirmedAt).toBeNull();

    const notification = await app.prisma.notification.findFirst({
      where: { userId, entityType: 'occurrence', entityId: null },
      select: { title: true },
    });
    expect(notification?.title).toContain('1');
  });

  it('manda il riepilogo nel giorno giusto, dentro lo stesso giro', async () => {
    await anExpense({ name: 'Hosting', startDate: d('2027-03-22') });

    const mailer = createMemoryMailer();
    await run(mailer);

    const digest = await app.prisma.reminderLog.findFirst({
      where: { userId, kind: 'DIGEST' },
      select: { dedupeKey: true, succeeded: true },
    });
    // La settimana ISO e non la data: `2027-03-15` è il lunedì di `2027-W11`.
    expect(digest?.dedupeKey).toBe(`DIGEST:${userId}:2027-W11:EMAIL`);
    expect(digest?.succeeded).toBe(true);
  });

  it('una spesa in valuta senza cambio non ferma le altre', async () => {
    // Il `try/catch` per singola spesa: senza, un 422 su una spesa in corone
    // diventerebbe «nessuna scadenza nuova per nessuno» e nessun avviso.
    await app.prisma.expense.create({
      data: {
        userId,
        name: 'In corone',
        netCents: 10_000,
        vatRateBp: 2200,
        grossCents: 12_200,
        currency: 'SEK',
        recurrenceUnit: 'MONTH',
        recurrenceInterval: 1,
        startDate: d('2027-03-22'),
        status: 'ACTIVE',
      },
    });
    await anExpense({ name: 'In euro', startDate: d('2027-03-22') });

    const mailer = createMemoryMailer();
    const result = await run(mailer);

    expect(result.counters.failures).toBe(1);
    expect(result.counters.occurrencesSynced).toBeGreaterThan(0);
    expect(mailer.sent.some((message) => message.text.includes('In euro'))).toBe(true);
  });

  it('un invio fallito non blocca il giro e non si ritenta', async () => {
    await anExpense({ name: 'Hosting', startDate: d('2027-03-22') });

    const mailer = createMemoryMailer();
    mailer.failNext('mittente non verificato');
    const first = await run(mailer);
    expect(first.counters.failures).toBeGreaterThan(0);

    // La notifica in-app c'è comunque: è la rete di sicurezza, ed è scritta
    // prima dell'email proprio per questo.
    expect(await app.prisma.notification.count({ where: { userId } })).toBeGreaterThan(0);

    const before = mailer.sent.length;
    await run(mailer);
    expect(mailer.sent).toHaveLength(before);
  });
});

describe('potatura delle notifiche', () => {
  it('toglie le lette vecchie e lascia stare le altre', async () => {
    const old = new Date(TODAY.getTime() - 200 * 86_400_000);
    await app.prisma.notification.createMany({
      data: [
        { userId, kind: 'EXPENSE_DUE', title: 'Letta e vecchia', body: '.', readAt: old },
        { userId, kind: 'EXPENSE_DUE', title: 'Non letta e vecchia', body: '.', readAt: null },
        { userId, kind: 'EXPENSE_DUE', title: 'Letta e recente', body: '.', readAt: TODAY },
      ],
    });

    await run(createMemoryMailer());

    const titles = await app.prisma.notification.findMany({
      where: { userId },
      select: { title: true },
    });
    const kept = titles.map((row) => row.title);
    expect(kept).not.toContain('Letta e vecchia');
    // Una non letta è un avviso che nessuno ha ancora visto: cancellarla
    // sarebbe perdere proprio quella che contava.
    expect(kept).toContain('Non letta e vecchia');
    expect(kept).toContain('Letta e recente');
  });

  it('non tocca mai il registro degli invii', async () => {
    // Svuotarlo rimanderebbe email già inviate: è la memoria della deduplica,
    // non uno storico di comodo.
    await app.prisma.reminderLog.create({
      data: {
        userId,
        kind: 'EXPENSE_DUE',
        channel: 'EMAIL',
        dedupeKey: `vecchia:${randomUUID()}`,
        referenceDate: d('2020-01-01'),
        succeeded: true,
      },
    });

    await run(createMemoryMailer());

    expect(await app.prisma.reminderLog.count({ where: { userId } })).toBeGreaterThan(0);
  });
});

describe('esecuzioni sovrapposte', () => {
  it('chi arriva secondo riceve il risultato del primo', async () => {
    // Un 409 sarebbe più esplicito e meno utile: chi ha premuto il pulsante
    // vuole i contatori del giro, e quelli del giro in corso rispondono alla
    // sua domanda.
    await anExpense({ name: 'Hosting', startDate: d('2027-03-22') });

    const mailer = createMemoryMailer();
    const context = contextWith(mailer);
    const [first, second] = await Promise.all([
      runJob('daily', context, { userId }),
      runJob('daily', context, { userId }),
    ]);

    expect(second).toBe(first);
    expect(mailer.sent).toHaveLength(first.counters.emailsSent);
  });
});
