import { randomUUID } from 'node:crypto';

import { type PlannedReminder, parseIsoDate, planReminders } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { type Env, parseEnv } from '../config/env';
import { type MemoryMailer, createMemoryMailer } from '../mail';
import { collectReminderInput } from './collect';
import { deliverReminders } from './deliver';
import type { JobContext } from './types';

/**
 * La parte che non si può provare senza database: l'ordine delle scritture.
 *
 * Le regole di scatto stanno in `reminders.test.ts`, pure e senza tabelle.
 * Quello che si prova qui è la deduplica — che è un vincolo del database, non
 * una `findFirst` — e cosa resta scritto quando l'invio fallisce.
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

const TODAY = d('2027-03-15');

function contextWith(mailer: MemoryMailer): JobContext {
  return {
    prisma: app.prisma,
    mailer,
    log: app.log,
    now: TODAY,
    baseUrl: 'http://localhost:5173',
    notificationRetentionDays: 180,
  };
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  email = `deliver-${randomUUID()}@easygest.test`;
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
  await app.prisma.notification.deleteMany({ where: { userId } });
  await app.prisma.expense.deleteMany({ where: { userId } });
  await app.prisma.paymentMethod.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await app.prisma.user.delete({ where: { id: userId } });
  await app.close();
});

/** Una spesa con una scadenza fra sette giorni: fa scattare l'anticipo a 7. */
async function anExpenseDueIn(days: number, name = 'Hosting'): Promise<void> {
  const dueDate = new Date(TODAY.getTime() + days * 86_400_000);
  await app.prisma.expense.create({
    data: {
      userId,
      name,
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: 12_200,
      currency: 'EUR',
      recurrenceUnit: 'MONTH',
      recurrenceInterval: 1,
      startDate: dueDate,
      status: 'ACTIVE',
      occurrences: {
        create: {
          userId,
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
  });
}

async function planned(): Promise<PlannedReminder[]> {
  return planReminders(await collectReminderInput(app.prisma, userId, TODAY));
}

async function deliver(mailer: MemoryMailer, autoPaid = 0): Promise<void> {
  await deliverReminders(
    contextWith(mailer),
    { id: userId, email },
    TODAY,
    await planned(),
    autoPaid,
  );
}

describe('consegna', () => {
  it('scrive una notifica e due righe di registro per ogni avviso', async () => {
    // Due `ReminderLog` con chiavi distinte, una per canale, e una sola
    // `Notification`: l'email raggruppa, la notifica no.
    await anExpenseDueIn(7);
    const mailer = createMemoryMailer();
    await deliver(mailer);

    const logs = await app.prisma.reminderLog.findMany({
      where: { userId },
      orderBy: { channel: 'asc' },
      select: { channel: true, dedupeKey: true, succeeded: true },
    });
    expect(logs.map((row) => row.channel)).toEqual(['EMAIL', 'IN_APP']);
    expect(logs.every((row) => row.succeeded)).toBe(true);
    expect(logs[0]?.dedupeKey.endsWith(':7:EMAIL')).toBe(true);

    expect(await app.prisma.notification.count({ where: { userId } })).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('due giri di fila non mandano due email', async () => {
    // L'idempotenza in tre righe: è la proprietà che permette di rifare il
    // giro a ogni avvio senza tenere un registro di «l'ho già fatto oggi».
    await anExpenseDueIn(7);
    const mailer = createMemoryMailer();
    await deliver(mailer);
    await deliver(mailer);

    expect(mailer.sent).toHaveLength(1);
    expect(await app.prisma.notification.count({ where: { userId } })).toBe(1);
    expect(await app.prisma.reminderLog.count({ where: { userId } })).toBe(2);
  });

  it('manda un\u2019email sola per pi\u00f9 scadenze dello stesso genere', async () => {
    // Cinque messaggi identici nella forma renderebbero il quinto invisibile.
    await anExpenseDueIn(7, 'Hosting');
    await anExpenseDueIn(5, 'Dominio');
    const mailer = createMemoryMailer();
    await deliver(mailer);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain('Hosting');
    expect(mailer.sent[0]?.text).toContain('Dominio');
    // Le notifiche in-app restano una per avviso: lì l'elenco è la pagina.
    expect(await app.prisma.notification.count({ where: { userId } })).toBe(2);
  });

  it('mette il link dell\u2019applicazione nell\u2019email e non nella notifica', async () => {
    await anExpenseDueIn(7);
    const mailer = createMemoryMailer();
    await deliver(mailer);

    expect(mailer.sent[0]?.text).toContain('http://localhost:5173/scadenze');
    const notification = await app.prisma.notification.findFirstOrThrow({ where: { userId } });
    expect(notification.body).not.toContain('http');
  });

  it('un invio fallito lascia la riga a succeeded = false e non si ritenta', async () => {
    // È la scelta dichiarata: fra «due volte» e «zero volte», zero è il danno
    // minore ed è l'unico recuperabile — la notifica in-app c'è già.
    await anExpenseDueIn(7);
    const mailer = createMemoryMailer();
    mailer.failNext('mittente non verificato');
    await deliver(mailer);

    const row = await app.prisma.reminderLog.findFirstOrThrow({
      where: { userId, channel: 'EMAIL' },
      select: { succeeded: true, errorMessage: true },
    });
    expect(row.succeeded).toBe(false);
    expect(row.errorMessage).toContain('mittente non verificato');
    // La notifica in-app è stata scritta comunque: è la rete di sicurezza.
    expect(await app.prisma.notification.count({ where: { userId } })).toBe(1);

    // Il giro successivo non riprova.
    await deliver(mailer);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('scadenze marcate pagate', () => {
  it('una notifica sola per giro, senza email', async () => {
    const mailer = createMemoryMailer();
    await deliver(mailer, 4);

    const notification = await app.prisma.notification.findFirstOrThrow({ where: { userId } });
    expect(notification.title).toContain('4');
    expect(notification.entityType).toBe('occurrence');
    // `entityId` nullo: parla di quattro occorrenze, non di una.
    expect(notification.entityId).toBeNull();
    expect(mailer.sent).toHaveLength(0);
  });

  it('non si ripete nello stesso giorno', async () => {
    const mailer = createMemoryMailer();
    await deliver(mailer, 4);
    await deliver(mailer, 4);

    expect(await app.prisma.notification.count({ where: { userId } })).toBe(1);
  });

  it('non dice niente quando non ha marcato niente', async () => {
    const mailer = createMemoryMailer();
    await deliver(mailer, 0);

    expect(await app.prisma.notification.count({ where: { userId } })).toBe(0);
  });
});
