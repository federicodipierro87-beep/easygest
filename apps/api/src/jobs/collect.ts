import type { OccurrenceView, PaymentMethodView, PlanRemindersInput } from '@easygest/shared';
import { addDays, startOfUtcDay } from '@easygest/shared';

import type { AppPrismaClient } from '../db/client';

/**
 * Le query che alimentano il motore dei promemoria.
 *
 * Sta qui e non in `packages/shared` per la stessa ragione per cui
 * `services/occurrences.ts` sta separato da `recurrence.ts`: il motore non deve
 * conoscere Prisma, altrimenti le sue regole diventano provabili solo con un
 * database acceso. Questo modulo fa l'unica cosa che il motore non può fare —
 * leggere — e mappa le righe nelle viste che lui capisce.
 */

/**
 * Quanto avanti si guarda.
 *
 * È il tetto dei preavvisi di disdetta (`cancellationNoticeDays` arriva a 730)
 * più un margine. Caricare tutte le occorrenze future sarebbe più semplice, ma
 * l'orizzonte è tredici mesi e le righe crescono con il numero di spese: questo
 * filtro toglie dalla query tutto ciò su cui nessun anticipo potrà mai
 * scattare.
 */
export const REMINDER_LOOKAHEAD_DAYS = 760;

/**
 * Le occorrenze su cui i promemoria possono scattare.
 *
 * Solo `PLANNED` e solo da oggi in poi: le pagate non hanno niente da
 * ricordare, e le scadute non ricevono avvisi — compaiono nel riepilogo
 * settimanale, dove il tono è quello di un elenco e non di un sollecito.
 */
async function collectOccurrences(
  prisma: AppPrismaClient,
  userId: string,
  today: Date,
): Promise<OccurrenceView[]> {
  const rows = await prisma.expenseOccurrence.findMany({
    where: {
      userId,
      status: 'PLANNED',
      dueDate: { gte: today, lte: addDays(today, REMINDER_LOOKAHEAD_DAYS) },
    },
    orderBy: { dueDate: 'asc' },
    select: {
      id: true,
      dueDate: true,
      status: true,
      grossCents: true,
      currency: true,
      expenseId: true,
      expense: {
        select: {
          name: true,
          status: true,
          autoRenew: true,
          cancellationNoticeDays: true,
          cancelledAt: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    dueDate: row.dueDate,
    status: row.status,
    grossCents: row.grossCents,
    currency: row.currency,
    expenseId: row.expenseId,
    expenseName: row.expense.name,
    expense: {
      status: row.expense.status,
      autoRenew: row.expense.autoRenew,
      cancellationNoticeDays: row.expense.cancellationNoticeDays,
      cancelledAt: row.expense.cancelledAt,
    },
  }));
}

/**
 * I metodi di pagamento con una scadenza, e quante spese attive ci pendono.
 *
 * Il conteggio è il motivo per cui questa query non è un `findMany` secco: una
 * carta che non paga più niente non è un problema, e avvisare per essa insegna
 * a ignorare gli avvisi. La regola però vive nel motore, non qui — questo
 * modulo porta il numero, il motore decide cosa farne, e così la decisione
 * resta provabile senza database.
 */
async function collectPaymentMethods(
  prisma: AppPrismaClient,
  userId: string,
): Promise<PaymentMethodView[]> {
  const rows = await prisma.paymentMethod.findMany({
    where: { userId, isActive: true, expiryMonth: { not: null }, expiryYear: { not: null } },
    select: {
      id: true,
      label: true,
      expiryMonth: true,
      expiryYear: true,
      isActive: true,
      _count: { select: { expenses: { where: { status: 'ACTIVE' } } } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    expiryMonth: row.expiryMonth,
    expiryYear: row.expiryYear,
    isActive: row.isActive,
    activeExpenseCount: row._count.expenses,
  }));
}

/** Gli anticipi configurati, con i default dello schema se la riga non c'è. */
async function collectSettings(
  prisma: AppPrismaClient,
  userId: string,
): Promise<PlanRemindersInput['settings']> {
  const settings = await prisma.settings.findUnique({
    where: { userId },
    select: { reminderDaysBefore: true, cancellationReminderDaysBefore: true },
  });

  // Un utente senza impostazioni non deve restare senza avvisi: la riga la crea
  // il seed, ma un utente arrivato per altra via avrebbe il silenzio totale
  // come comportamento, che è il peggiore dei difetti possibili qui.
  return {
    reminderDaysBefore: settings?.reminderDaysBefore ?? [30, 7, 1],
    cancellationReminderDaysBefore: settings?.cancellationReminderDaysBefore ?? [60, 30, 15],
  };
}

export async function collectReminderInput(
  prisma: AppPrismaClient,
  userId: string,
  today: Date,
): Promise<PlanRemindersInput> {
  const day = startOfUtcDay(today);

  const [settings, occurrences, paymentMethods] = await Promise.all([
    collectSettings(prisma, userId),
    collectOccurrences(prisma, userId, day),
    collectPaymentMethods(prisma, userId),
  ]);

  return { today: day, settings, occurrences, paymentMethods };
}
