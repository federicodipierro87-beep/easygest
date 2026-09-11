import {
  type DigestSections,
  addDays,
  cancellationDeadline,
  composeDigest,
  digestKey,
  isDigestEmpty,
  isoWeekday,
  startOfUtcDay,
} from '@easygest/shared';

import { Prisma } from '../generated/prisma/client';
import type { JobContext } from './types';

/**
 * Il riepilogo settimanale.
 *
 * Vive dentro il giro giornaliero e non ha una pianificazione propria: il
 * giorno in cui mandarlo è una preferenza dell'utente, letta dalle sue
 * impostazioni e valutata nel suo fuso. Un cron separato dovrebbe svegliarsi
 * tutti i giorni per rileggere le stesse righe e decidere la stessa cosa —
 * cioè fare esattamente questo, con una pianificazione in più da mantenere.
 */

/** Quanto avanti guarda la sezione delle scadenze. */
const UPCOMING_DAYS = 7;

/**
 * Quanto avanti guarda la sezione delle disdette.
 *
 * Trenta giorni e non sette: una finestra di disdetta si chiude una volta sola
 * e disdire richiede tempo — una raccomandata, un modulo, una telefonata — per
 * cui vederla arrivare da lontano è il punto. Le scadenze no: sono ricorrenti,
 * e quella del mese prossimo tornerà nel riepilogo della settimana giusta.
 */
const CANCELLATION_DAYS = 30;

/** Oggi è il giorno scelto dall'utente per il riepilogo? */
export function isDigestDay(today: Date, digestDayOfWeek: number): boolean {
  return isoWeekday(today) === digestDayOfWeek;
}

async function collectSections(
  { prisma }: Pick<JobContext, 'prisma'>,
  userId: string,
  today: Date,
): Promise<DigestSections> {
  const [upcoming, toConfirm, overdue, cancellable] = await Promise.all([
    prisma.expenseOccurrence.findMany({
      where: {
        userId,
        status: 'PLANNED',
        dueDate: { gte: today, lte: addDays(today, UPCOMING_DAYS) },
      },
      orderBy: { dueDate: 'asc' },
      select: {
        dueDate: true,
        grossCents: true,
        currency: true,
        expense: { select: { name: true } },
      },
    }),
    // Le marcate pagate dal cron e mai guardate da una persona: è la sezione
    // che dà al riepilogo una ragione d'esistere oltre ai promemoria, perché
    // è l'unico posto in cui un aumento di prezzo salta all'occhio.
    prisma.expenseOccurrence.findMany({
      where: { userId, status: 'PAID', confirmedAt: null },
      orderBy: { dueDate: 'asc' },
      take: 20,
      select: {
        dueDate: true,
        grossCents: true,
        currency: true,
        expense: { select: { name: true } },
      },
    }),
    // Le previste già scadute: quelle senza rinnovo automatico, che lo sweep
    // non tocca e che non ricevono promemoria.
    prisma.expenseOccurrence.findMany({
      where: { userId, status: 'PLANNED', dueDate: { lt: today } },
      orderBy: { dueDate: 'asc' },
      take: 20,
      select: {
        dueDate: true,
        grossCents: true,
        currency: true,
        expense: { select: { name: true } },
      },
    }),
    prisma.expenseOccurrence.findMany({
      where: {
        userId,
        status: 'PLANNED',
        dueDate: { gte: today },
        expense: {
          status: 'ACTIVE',
          autoRenew: true,
          cancelledAt: null,
          cancellationNoticeDays: { not: null },
        },
      },
      orderBy: { dueDate: 'asc' },
      select: {
        dueDate: true,
        grossCents: true,
        currency: true,
        expenseId: true,
        expense: { select: { name: true, cancellationNoticeDays: true } },
      },
    }),
  ]);

  const line = (row: {
    dueDate: Date;
    grossCents: number;
    currency: string;
    expense: { name: string };
  }) => ({
    label: row.expense.name,
    date: row.dueDate,
    grossCents: row.grossCents,
    currency: row.currency,
  });

  // Solo la prima occorrenza di ogni spesa, come nel motore dei promemoria:
  // un mensile con sessanta giorni di preavviso avrebbe due o tre occorrenze
  // dentro la finestra, e il riepilogo elencherebbe tre volte la stessa
  // decisione da prendere una volta sola.
  const seen = new Set<string>();
  const cancellations = [];
  for (const row of cancellable) {
    if (seen.has(row.expenseId)) continue;
    seen.add(row.expenseId);

    const notice = row.expense.cancellationNoticeDays;
    if (notice === null) continue;
    const deadline = cancellationDeadline(row.dueDate, notice);
    if (deadline === null) continue;
    if (deadline < today || deadline > addDays(today, CANCELLATION_DAYS)) continue;

    cancellations.push({
      label: row.expense.name,
      date: deadline,
      grossCents: row.grossCents,
      currency: row.currency,
      renewsOn: row.dueDate,
    });
  }

  return {
    upcoming: upcoming.map(line),
    cancellations,
    toConfirm: toConfirm.map(line),
    overdue: overdue.map(line),
  };
}

export interface DigestResult {
  sent: number;
  failures: number;
}

/**
 * Manda il riepilogo, se è il giorno e se c'è qualcosa da dire.
 *
 * La riga di deduplica si scrive **anche quando non si manda niente**: senza,
 * ogni riavvio dello stesso giorno rifarebbe le quattro query per riscoprire
 * che non c'è nulla. La chiave usa la settimana ISO e non la data — con la
 * data, spostare `digestDayOfWeek` da lunedì a mercoledì manderebbe due
 * riepiloghi nella stessa settimana.
 *
 * L'ordine è lo stesso delle email dei promemoria, e per le stesse ragioni:
 * prenota, invia, annota.
 */
export async function runDigest(
  context: JobContext,
  user: { id: string; email: string },
  today: Date,
  settings: { digestEnabled: boolean; digestDayOfWeek: number },
): Promise<DigestResult> {
  const day = startOfUtcDay(today);
  if (!settings.digestEnabled || !isDigestDay(day, settings.digestDayOfWeek)) {
    return { sent: 0, failures: 0 };
  }

  const { prisma, mailer, log, baseUrl } = context;
  const dedupeKey = digestKey(user.id, day);

  try {
    await prisma.reminderLog.create({
      data: {
        userId: user.id,
        kind: 'DIGEST',
        channel: 'EMAIL',
        dedupeKey,
        referenceDate: day,
        succeeded: false,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { sent: 0, failures: 0 };
    }
    throw error;
  }

  const sections = await collectSections(context, user.id, day);

  if (isDigestEmpty(sections)) {
    // Un'email che dice «non c'è niente» una volta a settimana è il modo più
    // efficace di far spegnere le notifiche. La riga resta, con `succeeded`
    // a false: non è un fallimento, è un invio che non è avvenuto, e la
    // distinzione la fa `errorMessage`.
    await prisma.reminderLog.updateMany({
      where: { dedupeKey },
      data: { errorMessage: 'riepilogo vuoto, non inviato' },
    });
    return { sent: 0, failures: 0 };
  }

  const message = composeDigest(sections, { baseUrl });

  try {
    await mailer.send({ to: user.email, subject: message.subject, text: message.text });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'errore sconosciuto';
    await prisma.reminderLog.updateMany({
      where: { dedupeKey },
      data: { errorMessage: reason.slice(0, 500) },
    });
    log.error({ err: error }, 'Riepilogo non inviato');
    return { sent: 0, failures: 1 };
  }

  await prisma.reminderLog.updateMany({ where: { dedupeKey }, data: { succeeded: true } });
  return { sent: 1, failures: 0 };
}
