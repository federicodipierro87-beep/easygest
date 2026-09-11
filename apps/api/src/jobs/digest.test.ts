import { randomUUID } from 'node:crypto';

import { parseIsoDate } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { type Env, parseEnv } from '../config/env';
import { type MemoryMailer, createMemoryMailer } from '../mail';
import { runDigest } from './digest';
import type { JobContext } from './types';

/**
 * Il riepilogo, provato dove le sue decisioni si vedono: nel database.
 *
 * Le due proprietà che contano non sono verificabili altrove. La prima è che
 * la chiave usa la **settimana** e non il giorno — spostare il giorno scelto
 * da lunedì a mercoledì non deve produrre due riepiloghi nella stessa
 * settimana. La seconda è che un riepilogo vuoto **non si manda ma si
 * registra**, altrimenti ogni riavvio della giornata rifarebbe le query per
 * riscoprire che non c'è nulla da dire.
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

/** Un lunedì: `isoWeekday` vale 1, che è il default di `digestDayOfWeek`. */
const MONDAY = d('2027-03-15');
/** Il mercoledì della stessa settimana ISO, `2027-W11`. */
const WEDNESDAY = d('2027-03-17');

const ON = { digestEnabled: true, digestDayOfWeek: 1 };

function contextWith(mailer: MemoryMailer): JobContext {
  return {
    prisma: app.prisma,
    mailer,
    log: app.log,
    now: MONDAY,
    baseUrl: 'http://localhost:5173',
    notificationRetentionDays: 180,
  };
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  email = `digest-${randomUUID()}@easygest.test`;
  const user = await app.prisma.user.create({
    data: {
      email,
      displayName: 'Utente di prova',
      passwordHash: 'non-usato',
      settings: { create: {} },
    },
    select: { id: true },
  });
  userId = user.id;
});

afterEach(async () => {
  await app.prisma.reminderLog.deleteMany({ where: { userId } });
  await app.prisma.expense.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await app.prisma.user.delete({ where: { id: userId } });
  await app.close();
});

interface OccurrenceOptions {
  name: string;
  dueDate: Date;
  status?: 'PLANNED' | 'PAID';
  confirmedAt?: Date | null;
  autoRenew?: boolean;
  cancellationNoticeDays?: number | null;
}

async function anExpense(options: OccurrenceOptions): Promise<void> {
  await app.prisma.expense.create({
    data: {
      userId,
      name: options.name,
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: 12_200,
      currency: 'EUR',
      recurrenceUnit: 'MONTH',
      recurrenceInterval: 1,
      startDate: options.dueDate,
      status: 'ACTIVE',
      autoRenew: options.autoRenew ?? false,
      cancellationNoticeDays: options.cancellationNoticeDays ?? null,
      occurrences: {
        create: {
          userId,
          dueDate: options.dueDate,
          periodStart: options.dueDate,
          netCents: 10_000,
          vatRateBp: 2200,
          grossCents: 12_200,
          currency: 'EUR',
          baseGrossCents: 12_200,
          status: options.status ?? 'PLANNED',
          paidAt: options.status === 'PAID' ? options.dueDate : null,
          confirmedAt: options.confirmedAt ?? null,
        },
      },
    },
  });
}

async function run(
  mailer: MemoryMailer,
  today = MONDAY,
  settings = ON,
): ReturnType<typeof runDigest> {
  return runDigest(contextWith(mailer), { id: userId, email }, today, settings);
}

describe('il giorno del riepilogo', () => {
  it('non manda niente se oggi non \u00e8 il giorno scelto', async () => {
    await anExpense({ name: 'Hosting', dueDate: d('2027-03-18') });
    const mailer = createMemoryMailer();

    const result = await run(mailer, MONDAY, { digestEnabled: true, digestDayOfWeek: 4 });

    expect(result.sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    // Nemmeno la riga di deduplica: non è il giorno, non c'è niente da segnare.
    expect(await app.prisma.reminderLog.count({ where: { userId } })).toBe(0);
  });

  it('non manda niente se il riepilogo \u00e8 spento', async () => {
    await anExpense({ name: 'Hosting', dueDate: d('2027-03-18') });
    const mailer = createMemoryMailer();

    await run(mailer, MONDAY, { digestEnabled: false, digestDayOfWeek: 1 });

    expect(mailer.sent).toHaveLength(0);
    expect(await app.prisma.reminderLog.count({ where: { userId } })).toBe(0);
  });
});

describe('contenuto', () => {
  it('mette nelle quattro sezioni ci\u00f2 che le riguarda', async () => {
    await anExpense({ name: 'Hosting', dueDate: d('2027-03-18') });
    await anExpense({ name: 'Bolletta', dueDate: d('2027-03-01') });
    await anExpense({ name: 'Licenza', dueDate: d('2027-03-10'), status: 'PAID' });
    await anExpense({
      name: 'Antivirus',
      dueDate: d('2027-04-24'),
      autoRenew: true,
      cancellationNoticeDays: 30,
    });

    const mailer = createMemoryMailer();
    const result = await run(mailer);

    expect(result.sent).toBe(1);
    const text = mailer.sent[0]?.text ?? '';
    expect(text).toContain('Hosting');
    expect(text).toContain('Bolletta');
    expect(text).toContain('Licenza');
    expect(text).toContain('Antivirus');
    expect(text).toContain('http://localhost:5173');
  });

  it('lascia fuori le pagate gi\u00e0 confermate', async () => {
    // È la sezione che dà al riepilogo una ragione d'esistere: serve a far
    // saltare all'occhio un aumento di prezzo che nessuno ha ancora guardato.
    // Una volta guardato, non ha più niente da dire.
    await anExpense({
      name: 'Licenza',
      dueDate: d('2027-03-10'),
      status: 'PAID',
      confirmedAt: d('2027-03-11'),
    });

    const mailer = createMemoryMailer();
    const result = await run(mailer);

    expect(result.sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('non manda un\u2019email per dire che non c\u2019\u00e8 niente', async () => {
    // Un messaggio vuoto una volta a settimana è il modo più efficace di far
    // spegnere le notifiche. La riga resta, per non rifare le query a ogni
    // riavvio della stessa giornata.
    const mailer = createMemoryMailer();
    const result = await run(mailer);

    expect(result.sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);

    const row = await app.prisma.reminderLog.findFirstOrThrow({
      where: { userId, kind: 'DIGEST' },
      select: { succeeded: true, errorMessage: true },
    });
    expect(row.succeeded).toBe(false);
    expect(row.errorMessage).toContain('vuoto');
  });
});

describe('deduplica', () => {
  it('due giri di fila non mandano due riepiloghi', async () => {
    await anExpense({ name: 'Hosting', dueDate: d('2027-03-18') });
    const mailer = createMemoryMailer();

    await run(mailer);
    await run(mailer);

    expect(mailer.sent).toHaveLength(1);
    expect(await app.prisma.reminderLog.count({ where: { userId } })).toBe(1);
  });

  it('spostare il giorno a met\u00e0 settimana non ne manda un secondo', async () => {
    // Il caso per cui la chiave porta la settimana ISO e non la data: lunedì
    // il riepilogo è partito, mercoledì l'utente sposta la preferenza, e con
    // una chiave per giorno si ritroverebbe due riepiloghi in tre giorni.
    await anExpense({ name: 'Hosting', dueDate: d('2027-03-18') });
    const mailer = createMemoryMailer();

    await run(mailer, MONDAY, { digestEnabled: true, digestDayOfWeek: 1 });
    await run(mailer, WEDNESDAY, { digestEnabled: true, digestDayOfWeek: 3 });

    expect(mailer.sent).toHaveLength(1);
  });

  it('un invio fallito lascia la riga a succeeded = false e non si ritenta', async () => {
    await anExpense({ name: 'Hosting', dueDate: d('2027-03-18') });
    const mailer = createMemoryMailer();
    mailer.failNext('mittente non verificato');

    const result = await run(mailer);
    expect(result.failures).toBe(1);

    const row = await app.prisma.reminderLog.findFirstOrThrow({
      where: { userId, kind: 'DIGEST' },
      select: { succeeded: true, errorMessage: true },
    });
    expect(row.succeeded).toBe(false);
    expect(row.errorMessage).toContain('mittente non verificato');

    await run(mailer);
    expect(mailer.sent).toHaveLength(0);
  });
});
