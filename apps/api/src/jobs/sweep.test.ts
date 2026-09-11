import { randomUUID } from 'node:crypto';

import { formatIsoDate, parseIsoDate } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { type Env, parseEnv } from '../config/env';
import { createMemoryMailer } from '../mail';
import type { Expense } from '../generated/prisma/client';
import type { OccurrenceContext } from '../services/occurrences';
import { runSweep } from './sweep';
import type { JobContext } from './types';

/**
 * Le due manutenzioni, provate su un database vero.
 *
 * Non c'è modo di verificarle altrove: riguardano proprio cosa succede alle
 * righe che c'erano già, e il caso che conta — una spesa in valuta senza tasso
 * che non deve fermare le altre — esiste solo se le righe sono vere.
 */

/** Come in `occurrences.test.ts`: i cambi sono una tabella sola per tutti. */
const OWNED_CURRENCY = 'SEK';

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

let app: FastifyInstance;
let userId: string;

const d = (value: string): Date => {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error(`Data di test non valida: ${value}`);
  return parsed;
};

const TODAY = d('2027-03-15');
const occurrences: OccurrenceContext = { baseCurrency: 'EUR', today: TODAY };

function jobContext(): JobContext {
  return {
    prisma: app.prisma,
    mailer: createMemoryMailer(),
    log: app.log,
    now: TODAY,
    baseUrl: 'http://localhost:5173',
    notificationRetentionDays: 180,
  };
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  const user = await app.prisma.user.create({
    data: {
      email: `sweep-${randomUUID()}@easygest.test`,
      displayName: 'Utente di prova',
      passwordHash: 'non-usato',
      settings: { create: {} },
    },
    select: { id: true },
  });
  userId = user.id;
});

afterEach(async () => {
  await app.prisma.expense.deleteMany({ where: { userId } });
  await app.prisma.fxRate.deleteMany({ where: { quote: OWNED_CURRENCY } });
});

afterAll(async () => {
  await app.prisma.user.delete({ where: { id: userId } });
  await app.close();
});

async function makeExpense(overrides: Partial<Expense> = {}): Promise<Expense> {
  return app.prisma.expense.create({
    data: {
      userId,
      name: 'Abbonamento di prova',
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: 12_200,
      currency: 'EUR',
      recurrenceUnit: 'MONTH',
      recurrenceInterval: 1,
      startDate: TODAY,
      status: 'ACTIVE',
      autoRenew: true,
      ...overrides,
    },
  });
}

describe('estensione dell\u2019orizzonte', () => {
  it('materializza le scadenze delle spese attive senza che nessuno le tocchi', async () => {
    // È il debito dichiarato in PROGRESS: finora le occorrenze nascevano solo
    // quando qualcuno modificava la spesa.
    const expense = await makeExpense();
    const result = await runSweep(jobContext(), userId, occurrences);

    expect(result.occurrencesSynced).toBe(14);
    expect(result.failures).toBe(0);
    expect(await app.prisma.expenseOccurrence.count({ where: { expenseId: expense.id } })).toBe(14);
  });

  it('rilanciato non scrive niente di nuovo', async () => {
    await makeExpense();
    await runSweep(jobContext(), userId, occurrences);
    const second = await runSweep(jobContext(), userId, occurrences);

    expect(second.occurrencesSynced).toBe(0);
  });

  it('lascia stare le spese che non sono attive', async () => {
    const paused = await makeExpense({ status: 'PAUSED' });
    await runSweep(jobContext(), userId, occurrences);

    expect(await app.prisma.expenseOccurrence.count({ where: { expenseId: paused.id } })).toBe(0);
  });

  it('una spesa senza cambio non ferma le altre', async () => {
    // Il `try/catch` è per singola spesa proprio per questo: senza, un 422 su
    // una spesa in corone diventerebbe «nessuna scadenza nuova per nessuno»,
    // senza un errore visibile da nessuna parte.
    await makeExpense({ name: 'In corone', currency: OWNED_CURRENCY });
    const sana = await makeExpense({ name: 'In euro' });

    const result = await runSweep(jobContext(), userId, occurrences);

    expect(result.failures).toBe(1);
    expect(result.occurrencesSynced).toBe(14);
    expect(await app.prisma.expenseOccurrence.count({ where: { expenseId: sana.id } })).toBe(14);
  });
});

describe('marcatura delle scadute', () => {
  it('marca pagate le arretrate con rinnovo automatico', async () => {
    const expense = await makeExpense({ startDate: d('2027-01-15') });
    await runSweep(jobContext(), userId, occurrences);

    // Le due arretrate le scrive il test: `syncOccurrences` non materializza
    // il passato di proposito.
    await app.prisma.expenseOccurrence.createMany({
      data: [d('2027-01-15'), d('2027-02-15')].map((dueDate) => ({
        userId,
        expenseId: expense.id,
        dueDate,
        periodStart: dueDate,
        netCents: 10_000,
        vatRateBp: 2200,
        grossCents: 12_200,
        currency: 'EUR',
        baseGrossCents: 12_200,
      })),
    });

    const result = await runSweep(jobContext(), userId, occurrences);
    expect(result.markedPaid).toBe(2);

    const rows = await app.prisma.expenseOccurrence.findMany({
      where: { expenseId: expense.id, status: 'PAID' },
      orderBy: { dueDate: 'asc' },
      select: { dueDate: true, paidAt: true, confirmedAt: true },
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // `paidAt = dueDate` e non «adesso»: l'addebito è avvenuto il giorno
      // della scadenza, non il giorno in cui il cron se n'è accorto. Con
      // `now`, un giro saltato per due giorni sposterebbe i pagamenti di due
      // giorni e i conti finirebbero nel mese sbagliato.
      expect(row.paidAt === null ? null : formatIsoDate(row.paidAt)).toBe(
        formatIsoDate(row.dueDate),
      );
      // `confirmedAt` resta nullo: è il meccanismo con cui ci si accorge degli
      // aumenti di prezzo, e il cron non ha guardato nessun importo.
      expect(row.confirmedAt).toBeNull();
    }
  });

  it('non tocca le scadute senza rinnovo automatico', async () => {
    // Una spesa che non si rinnova da sé e non è stata pagata è un debito
    // vero: marcarla pagata sarebbe inventare un pagamento.
    const expense = await makeExpense({ autoRenew: false, startDate: d('2027-01-15') });
    await app.prisma.expenseOccurrence.create({
      data: {
        userId,
        expenseId: expense.id,
        dueDate: d('2027-02-15'),
        periodStart: d('2027-02-15'),
        netCents: 10_000,
        vatRateBp: 2200,
        grossCents: 12_200,
        currency: 'EUR',
        baseGrossCents: 12_200,
      },
    });

    const result = await runSweep(jobContext(), userId, occurrences);
    expect(result.markedPaid).toBe(0);
  });

  it('non tocca quelle che scadono oggi o dopo', async () => {
    // Oggi non è ancora passato: marcarla pagata la mattina del 15 direbbe
    // che è uscito del denaro che forse esce stasera.
    await makeExpense();
    const result = await runSweep(jobContext(), userId, occurrences);

    expect(result.markedPaid).toBe(0);
  });

  it('rilanciato non marca due volte', async () => {
    const expense = await makeExpense({ startDate: d('2027-01-15') });
    await app.prisma.expenseOccurrence.create({
      data: {
        userId,
        expenseId: expense.id,
        dueDate: d('2027-02-15'),
        periodStart: d('2027-02-15'),
        netCents: 10_000,
        vatRateBp: 2200,
        grossCents: 12_200,
        currency: 'EUR',
        baseGrossCents: 12_200,
      },
    });

    expect((await runSweep(jobContext(), userId, occurrences)).markedPaid).toBe(1);
    expect((await runSweep(jobContext(), userId, occurrences)).markedPaid).toBe(0);
  });
});
