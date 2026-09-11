import {
  type NotificationEntityType,
  type PlannedReminder,
  type ReminderTargetKind,
  autoPaidKey,
  composeAutoPaidMessage,
  composeReminderMessage,
  startOfUtcDay,
} from '@easygest/shared';

import { Prisma } from '../generated/prisma/client';
import type { JobContext } from './types';

/**
 * Dalla decisione alla scrittura.
 *
 * Il motore ha già deciso *cosa* dire e con *quale chiave*; qui si decide
 * soltanto in che ordine toccare il database e la rete. È una decisione più
 * piccola e più delicata di quanto sembri, e ha una risposta diversa per i due
 * canali.
 */

export interface DeliveryCounters {
  emailsSent: number;
  notificationsCreated: number;
  failures: number;
}

/** A cosa punta il link di una notifica, dedotto dal genere. */
function entityFor(reminder: PlannedReminder): {
  entityType: NotificationEntityType;
  entityId: string | null;
} {
  if (reminder.kind === 'CARD_EXPIRING') {
    return { entityType: 'paymentMethod', entityId: reminder.paymentMethodId };
  }
  return { entityType: 'occurrence', entityId: reminder.occurrenceId };
}

/** `P2002` è il vincolo unico su `dedupeKey`: non è un errore, è la deduplica che funziona. */
function isDuplicate(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Le notifiche in-app: una transazione, due scritture, nessuna rete.
 *
 * `Notification.create` e `ReminderLog.create` insieme, e il `P2002` sulla
 * seconda fa fallire anche la prima. È il punto: la garanzia di non duplicare
 * viene dal vincolo unico del database, non da una `findFirst` prima di
 * scrivere, che sarebbe una corsa fra il controllo e la scrittura.
 *
 * Vengono **prima** delle email, sempre. Una riga in tabella non dipende da
 * nessun servizio esterno e non può fallire per ragioni altrui, quindi se
 * Resend è giù l'avviso esiste comunque — è la rete di sicurezza, e una rete di
 * sicurezza tesa dopo il salto non serve.
 */
async function deliverInApp(
  { prisma, log }: Pick<JobContext, 'prisma' | 'log'>,
  userId: string,
  reminders: readonly PlannedReminder[],
): Promise<{ created: number; failures: number }> {
  let created = 0;
  let failures = 0;

  for (const reminder of reminders) {
    const message = composeReminderMessage(reminder.kind, [reminder]);
    const { entityType, entityId } = entityFor(reminder);

    try {
      await prisma.$transaction(async (tx) => {
        await tx.notification.create({
          data: {
            userId,
            kind: reminder.kind,
            title: message.title,
            body: message.text,
            entityType,
            entityId,
          },
        });
        await tx.reminderLog.create({
          data: {
            userId,
            kind: reminder.kind,
            channel: 'IN_APP',
            dedupeKey: reminder.keys.IN_APP,
            occurrenceId: reminder.occurrenceId,
            referenceDate: reminder.referenceDate,
          },
        });
      });
      created += 1;
    } catch (error) {
      if (isDuplicate(error)) continue;
      failures += 1;
      log.warn({ err: error, dedupeKey: reminder.keys.IN_APP }, 'Notifica non scritta');
    }
  }

  return { created, failures };
}

/**
 * Le email: prenota, invia, annota.
 *
 * I due ordini possibili sbagliano in modi non simmetrici, e vale la pena
 * scriverlo perché la scelta è controintuitiva.
 *
 * Scrivere la riga **dopo** l'invio significa che un crash a metà rimanda la
 * stessa email: l'utente che riceve due promemoria identici per la stessa
 * scadenza conclude che i dati sono sbagliati, e da lì in poi non si fida più
 * di nessun avviso.
 *
 * Scrivere **prima** significa poterne perdere una — ma la riga resta lì, con
 * `succeeded = false`, a raccontare esattamente quale e perché. Fra «due
 * volte» e «zero volte», zero è il danno minore, ed è anche l'unico dei due
 * recuperabile: la notifica in-app è già stata scritta, prima.
 *
 * **Non si ritenta**, come dice il commento dello schema: un tentativo
 * automatico su un errore che di solito è permanente — mittente non
 * verificato, destinatario rifiutato — moltiplica le chiamate senza cambiare
 * l'esito. Per riprovare si cancella la riga a mano.
 *
 * Un'email **per genere per giro**: cinque scadenze nella stessa settimana in
 * cinque messaggi identici nella forma renderebbero il quinto invisibile.
 */
async function deliverEmail(
  { prisma, mailer, log, baseUrl }: JobContext,
  userId: string,
  email: string,
  kind: ReminderTargetKind,
  reminders: readonly PlannedReminder[],
): Promise<{ sent: number; failures: number }> {
  // 1. Prenota. Chi ha già la chiave si è già visto l'email in un giro
  //    precedente e non deve rientrare nel gruppo di questo.
  const reserved: PlannedReminder[] = [];
  for (const reminder of reminders) {
    try {
      await prisma.reminderLog.create({
        data: {
          userId,
          kind: reminder.kind,
          channel: 'EMAIL',
          dedupeKey: reminder.keys.EMAIL,
          occurrenceId: reminder.occurrenceId,
          referenceDate: reminder.referenceDate,
          succeeded: false,
        },
      });
      reserved.push(reminder);
    } catch (error) {
      if (isDuplicate(error)) continue;
      log.warn({ err: error, dedupeKey: reminder.keys.EMAIL }, 'Prenotazione fallita');
    }
  }

  if (reserved.length === 0) return { sent: 0, failures: 0 };

  const keys = reserved.map((reminder) => reminder.keys.EMAIL);
  const message = composeReminderMessage(kind, reserved, { baseUrl });

  // 2. Invia.
  try {
    await mailer.send({ to: email, subject: message.subject, text: message.text });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'errore sconosciuto';
    await prisma.reminderLog.updateMany({
      where: { dedupeKey: { in: keys } },
      data: { errorMessage: reason.slice(0, 500) },
    });
    log.error({ err: error, kind, count: reserved.length }, 'Email non inviata');
    return { sent: 0, failures: 1 };
  }

  // 3. Annota l'esito. `updateMany` su tutte le chiavi del gruppo: l'invio è
  //    stato uno solo, e o sono riuscite tutte o è fallito tutto.
  await prisma.reminderLog.updateMany({
    where: { dedupeKey: { in: keys } },
    data: { succeeded: true },
  });

  return { sent: 1, failures: 0 };
}

/**
 * La notifica delle scadenze marcate pagate.
 *
 * Una sola per giro, raggruppata: `markAutoPaid` può averne toccate dodici in
 * una volta il giorno in cui l'applicazione riprende dopo una pausa, e dodici
 * notifiche identiche seppellirebbero tutto il resto.
 *
 * Il genere è `EXPENSE_DUE` perché l'enum non ne ha uno che calzi e aggiungerlo
 * richiederebbe una migrazione per un'etichetta. `entityId` è nullo — parla di
 * N occorrenze, non di una — e `notificationHref` manda comunque a `/scadenze`,
 * che è dove le si conferma.
 *
 * Solo in-app, niente email: non è un avviso su qualcosa che sta per succedere,
 * è il resoconto di qualcosa che l'applicazione ha appena fatto, e sta bene
 * dove si va a controllarlo.
 */
async function deliverAutoPaid(
  { prisma, log }: Pick<JobContext, 'prisma' | 'log'>,
  userId: string,
  today: Date,
  count: number,
): Promise<{ created: number; failures: number }> {
  if (count === 0) return { created: 0, failures: 0 };

  const message = composeAutoPaidMessage(count);
  const day = startOfUtcDay(today);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.notification.create({
        data: {
          userId,
          kind: 'EXPENSE_DUE',
          title: message.title,
          body: message.body,
          entityType: 'occurrence',
          entityId: null,
        },
      });
      await tx.reminderLog.create({
        data: {
          userId,
          kind: 'EXPENSE_DUE',
          channel: 'IN_APP',
          dedupeKey: autoPaidKey(userId, day),
          referenceDate: day,
        },
      });
    });
    return { created: 1, failures: 0 };
  } catch (error) {
    if (isDuplicate(error)) return { created: 0, failures: 0 };
    log.warn({ err: error }, 'Notifica delle marcate pagate non scritta');
    return { created: 0, failures: 1 };
  }
}

/** Raggruppa per genere mantenendo l'ordine che il motore ha già scelto. */
function groupByKind(
  reminders: readonly PlannedReminder[],
): Map<ReminderTargetKind, PlannedReminder[]> {
  const groups = new Map<ReminderTargetKind, PlannedReminder[]>();
  for (const reminder of reminders) {
    const group = groups.get(reminder.kind);
    if (group === undefined) groups.set(reminder.kind, [reminder]);
    else group.push(reminder);
  }
  return groups;
}

export async function deliverReminders(
  context: JobContext,
  user: { id: string; email: string },
  today: Date,
  reminders: readonly PlannedReminder[],
  autoPaidCount: number,
): Promise<DeliveryCounters> {
  const counters: DeliveryCounters = { emailsSent: 0, notificationsCreated: 0, failures: 0 };

  // In-app prima, sempre: è la rete di sicurezza.
  const inApp = await deliverInApp(context, user.id, reminders);
  counters.notificationsCreated += inApp.created;
  counters.failures += inApp.failures;

  const autoPaid = await deliverAutoPaid(context, user.id, today, autoPaidCount);
  counters.notificationsCreated += autoPaid.created;
  counters.failures += autoPaid.failures;

  for (const [kind, group] of groupByKind(reminders)) {
    const result = await deliverEmail(context, user.id, user.email, kind, group);
    counters.emailsSent += result.sent;
    counters.failures += result.failures;
  }

  return counters;
}
