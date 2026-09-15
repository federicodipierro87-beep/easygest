import { randomUUID } from 'node:crypto';

import { composeDigest, parseIsoDate } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { type Env, parseEnv } from '../config/env';
import { collectAgenda, toDigestSections } from './agenda';

/**
 * L'agenda, provata dove le sue decisioni si vedono: nel database.
 *
 * Due proprietà giustificano questo file da sole. La prima è che `total` e
 * `totalCents` contino **tutte** le righe e non solo quelle restituite: è
 * l'errore che la dashboard farebbe in silenzio, dicendo «5 da confermare»
 * quando sono trenta. La seconda è l'isolamento fra utenti, che qui non è
 * teorico — ogni `where` porta `userId` a mano, e basta dimenticarlo in una
 * delle quattro sezioni.
 *
 * `digest.test.ts` non è stato toccato, ed è la prova che l'estrazione non ha
 * cambiato semantica. Quello che si aggiunge qui è la parte che il digest non
 * usa: i conteggi, il `take` parametrico, e `occurrenceId`.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

let app: FastifyInstance;
let alice: string;
let bob: string;

const d = (value: string): Date => {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error(`Data di test non valida: ${value}`);
  return parsed;
};

/** Il giorno in cui questo file vive. Fisso: l'agenda è relativa a «oggi». */
const TODAY = d('2027-03-15');

async function createUser(): Promise<string> {
  const user = await app.prisma.user.create({
    data: {
      email: `agenda-${randomUUID()}@easygest.test`,
      displayName: 'Utente di prova',
      passwordHash: 'non-usato',
      settings: { create: {} },
    },
    select: { id: true },
  });
  return user.id;
}

interface ExpenseOptions {
  userId: string;
  name: string;
  /** Le scadenze da materializzare, tutte con lo stesso importo. */
  dueDates: Date[];
  status?: 'PLANNED' | 'PAID' | 'SKIPPED' | 'CANCELLED';
  confirmedAt?: Date | null;
  autoRenew?: boolean;
  cancellationNoticeDays?: number | null;
  baseGrossCents?: number;
}

async function anExpense(options: ExpenseOptions): Promise<string> {
  const base = options.baseGrossCents ?? 12_200;
  const expense = await app.prisma.expense.create({
    data: {
      userId: options.userId,
      name: options.name,
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: 12_200,
      currency: 'EUR',
      recurrenceUnit: 'MONTH',
      recurrenceInterval: 1,
      startDate: options.dueDates[0] ?? TODAY,
      status: 'ACTIVE',
      autoRenew: options.autoRenew ?? false,
      cancellationNoticeDays: options.cancellationNoticeDays ?? null,
      occurrences: {
        create: options.dueDates.map((dueDate) => ({
          userId: options.userId,
          dueDate,
          periodStart: dueDate,
          netCents: 10_000,
          vatRateBp: 2200,
          grossCents: 12_200,
          currency: 'EUR',
          baseGrossCents: base,
          status: options.status ?? 'PLANNED',
          paidAt: options.status === 'PAID' ? dueDate : null,
          confirmedAt: options.confirmedAt ?? null,
        })),
      },
    },
    select: { id: true },
  });
  return expense.id;
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  alice = await createUser();
  bob = await createUser();
});

afterEach(async () => {
  await app.prisma.expense.deleteMany({ where: { userId: { in: [alice, bob] } } });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } });
  await app.close();
});

describe('classificazione', () => {
  it('mette ogni scadenza nella sezione che le compete', async () => {
    await anExpense({ userId: alice, name: 'Hosting', dueDates: [d('2027-03-18')] });
    await anExpense({ userId: alice, name: 'Bolletta', dueDates: [d('2027-03-01')] });
    await anExpense({
      userId: alice,
      name: 'Licenza',
      dueDates: [d('2027-03-10')],
      status: 'PAID',
    });
    await anExpense({
      userId: alice,
      name: 'Antivirus',
      dueDates: [d('2027-04-20')],
      autoRenew: true,
      cancellationNoticeDays: 30,
    });

    const agenda = await collectAgenda(app.prisma, alice, TODAY);

    expect(agenda.upcoming.rows.map((row) => row.expenseName)).toEqual(['Hosting']);
    expect(agenda.overdue.rows.map((row) => row.expenseName)).toEqual(['Bolletta']);
    expect(agenda.toConfirm.rows.map((row) => row.expenseName)).toEqual(['Licenza']);
    expect(agenda.cancellations.rows.map((row) => row.expenseName)).toEqual(['Antivirus']);
  });

  it('la riga porta l’identificativo dell’occorrenza, non solo quello della spesa', async () => {
    // È quello che serve a confermare una scadenza dalla dashboard: senza,
    // il riquadro «da confermare» sarebbe un elenco su cui non si può agire.
    await anExpense({
      userId: alice,
      name: 'Licenza',
      dueDates: [d('2027-03-10')],
      status: 'PAID',
    });

    const agenda = await collectAgenda(app.prisma, alice, TODAY);
    const row = agenda.toConfirm.rows[0];

    const occurrence = await app.prisma.expenseOccurrence.findUniqueOrThrow({
      where: { id: row?.occurrenceId ?? '' },
      select: { expenseId: true },
    });
    expect(occurrence.expenseId).toBe(row?.expenseId);
  });

  it('lascia fuori le pagate già confermate', async () => {
    await anExpense({
      userId: alice,
      name: 'Licenza',
      dueDates: [d('2027-03-10')],
      status: 'PAID',
      confirmedAt: d('2027-03-11'),
    });

    const agenda = await collectAgenda(app.prisma, alice, TODAY);
    expect(agenda.toConfirm.total).toBe(0);
  });

  it('di una spesa mensile la disdetta è una sola', async () => {
    // Dodici rinnovi producono dodici occorrenze, ma la finestra da decidere è
    // una: le altre undici sarebbero la stessa riga ripetuta.
    //
    // Le date non sono scelte a caso. Con trenta giorni di preavviso i primi
    // due rinnovi cadono **entrambi** dentro la finestra — il 14 aprile ha
    // termine oggi, il 14 maggio fra trenta giorni esatti — per cui a ridurli
    // a uno è la deduplica e non il filtro sulle date. Con rinnovi più
    // distanti il test sarebbe passato anche senza deduplica, provando nulla.
    // Di rimbalzo fissa che i due estremi della finestra sono inclusi.
    await anExpense({
      userId: alice,
      name: 'Antivirus',
      dueDates: [d('2027-04-14'), d('2027-05-14'), d('2027-06-14')],
      autoRenew: true,
      cancellationNoticeDays: 30,
    });

    const agenda = await collectAgenda(app.prisma, alice, TODAY);

    expect(agenda.cancellations.total).toBe(1);
    expect(agenda.cancellations.rows[0]?.deadline).toEqual(d('2027-03-15'));
    // Il rinnovo a cui il termine si riferisce resta accanto: senza, «entro il
    // 15 marzo» non dice cosa succede il 16.
    expect(agenda.cancellations.rows[0]?.dueDate).toEqual(d('2027-04-14'));
  });
});

describe('conteggi', () => {
  it('dice quante sono, non quante ne mostra', async () => {
    // È il bug per cui l'estrazione esiste: con `rows.length` la dashboard
    // direbbe «3 da confermare» con sette scadenze da controllare.
    await anExpense({
      userId: alice,
      name: 'Licenza',
      dueDates: [
        d('2027-03-01'),
        d('2027-03-02'),
        d('2027-03-03'),
        d('2027-03-04'),
        d('2027-03-05'),
        d('2027-03-06'),
        d('2027-03-07'),
      ],
      status: 'PAID',
      baseGrossCents: 1000,
    });

    const agenda = await collectAgenda(app.prisma, alice, TODAY, { take: 3 });

    expect(agenda.toConfirm.rows).toHaveLength(3);
    expect(agenda.toConfirm.total).toBe(7);
    expect(agenda.toConfirm.totalCents).toBe(7000);
  });

  it('una sezione vuota vale zero, non nulla', async () => {
    // Postgres restituisce `null` dalla somma di un insieme vuoto, e un `null`
    // che arriva in pagina si stampa come «NaN €».
    const agenda = await collectAgenda(app.prisma, alice, TODAY);

    expect(agenda.overdue.total).toBe(0);
    expect(agenda.overdue.totalCents).toBe(0);
  });

  it('somma la valuta base, non quella scritta sulla fattura', async () => {
    await anExpense({
      userId: alice,
      name: 'Hosting',
      dueDates: [d('2027-03-18')],
      baseGrossCents: 9999,
    });

    const agenda = await collectAgenda(app.prisma, alice, TODAY);
    expect(agenda.upcoming.totalCents).toBe(9999);
    expect(agenda.upcoming.rows[0]?.grossCents).toBe(12_200);
  });
});

describe('isolamento', () => {
  it('le scadenze di Bob non compaiono mai nell’agenda di Alice', async () => {
    await anExpense({ userId: bob, name: 'Hosting', dueDates: [d('2027-03-18')] });
    await anExpense({ userId: bob, name: 'Bolletta', dueDates: [d('2027-03-01')] });
    await anExpense({ userId: bob, name: 'Licenza', dueDates: [d('2027-03-10')], status: 'PAID' });
    await anExpense({
      userId: bob,
      name: 'Antivirus',
      dueDates: [d('2027-04-10')],
      autoRenew: true,
      cancellationNoticeDays: 30,
    });

    const agenda = await collectAgenda(app.prisma, alice, TODAY);

    expect(agenda.upcoming.total).toBe(0);
    expect(agenda.overdue.total).toBe(0);
    expect(agenda.toConfirm.total).toBe(0);
    expect(agenda.cancellations.total).toBe(0);
  });
});

describe('traduzione per il riepilogo', () => {
  it('produce sezioni che `composeDigest` sa comporre', async () => {
    await anExpense({ userId: alice, name: 'Hosting', dueDates: [d('2027-03-18')] });
    await anExpense({
      userId: alice,
      name: 'Antivirus',
      dueDates: [d('2027-04-20')],
      autoRenew: true,
      cancellationNoticeDays: 30,
    });

    const sections = toDigestSections(await collectAgenda(app.prisma, alice, TODAY, { take: 20 }));
    const message = composeDigest(sections, { baseUrl: 'http://localhost:5173' });

    expect(message.subject).toContain('1 scadenza in arrivo');
    expect(message.text).toContain('Hosting');
    // Nella sezione delle disdette la data è il termine, non il rinnovo.
    expect(message.text).toContain('entro il 2027-03-21');
    expect(message.text).toContain('rinnovo il 2027-04-20');
  });
});
