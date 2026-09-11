import { planReminders } from '@easygest/shared';

import { TRACKED_CURRENCIES, syncFxRates } from '../services/frankfurter';
import { occurrenceContext } from '../services/occurrences';
import { collectReminderInput } from './collect';
import { deliverReminders } from './deliver';
import { runDigest } from './digest';
import { runSweep } from './sweep';
import { type JobContext, type JobCounters, type JobResult, emptyCounters } from './types';

/**
 * Il giro notturno, in fila.
 *
 * L'ordine non è una preferenza, è un vincolo:
 *
 * 1. **Cambi** per primi, perché il passo 2 ne ha bisogno: materializzare
 *    un'occorrenza in dollari senza il tasso del giorno fallisce con un 422.
 * 2. **Sweep**, perché è lui a creare le occorrenze su cui scattano i
 *    promemoria. Invertendolo con il passo 3, il giorno in cui l'orizzonte si
 *    estende la scadenza appena nata non riceverebbe il suo avviso a trenta
 *    giorni: al momento del controllo non esisteva.
 * 3. **Promemoria**, che leggono ciò che i due passi precedenti hanno scritto.
 * 4. **Riepilogo**, che ha bisogno delle marcate pagate del passo 2 per la sua
 *    sezione «da confermare».
 * 5. **Potatura**, per ultima e senza conseguenze su nessuno.
 *
 * Tutto il giro è **idempotente per costruzione**: nessun passo tiene un
 * registro di «l'ho già fatto oggi», perché ognuno si difende da sé — i cambi
 * con `skipDuplicates`, lo sweep con il vincolo `(expenseId, dueDate)`, la
 * consegna con quello su `dedupeKey`. È la proprietà che rende sicuro rifare
 * il giro a ogni avvio, e quindi che rende inutile un registro delle
 * esecuzioni.
 */

/**
 * I cambi, da soli.
 *
 * Ha una pianificazione propria perché la BCE pubblica alle 16:00 CET e
 * aspettare il mattino dopo vorrebbe dire tenere le occorrenze di oggi ferme
 * per un giorno. Un fallimento qui non ferma il giro: i tassi restano quelli di
 * ieri, che `findRate` accetta fino a dieci giorni, e le spese in euro — cioè
 * quasi tutte — non se ne accorgono nemmeno.
 */
async function syncRates(context: JobContext, counters: JobCounters): Promise<void> {
  const { prisma, log, now, fetcher } = context;
  try {
    const result = await syncFxRates(prisma, { on: now, currencies: TRACKED_CURRENCIES, fetcher });
    counters.fxRates += result.written;
  } catch (error) {
    counters.failures += 1;
    log.warn({ err: error }, 'Cambi non sincronizzati');
  }
}

/**
 * Il giro di un singolo utente.
 *
 * Ogni utente ha il **proprio** `occurrenceContext`, quindi il proprio «oggi»:
 * `CRON_TIMEZONE` decide a che ora parte il giro, `Settings.timezone` decide
 * quale giorno è per chi lo riceve. Se divergessero, l'unico effetto è
 * un'email a un'ora strana — non un conto sbagliato.
 *
 * Il `try/catch` è intorno all'utente intero, come nello sweep lo è intorno
 * alla singola spesa e per la stessa ragione: oggi la tabella ha una riga, ma
 * il giorno in cui ne avrà dieci un problema sui dati di uno non deve lasciare
 * gli altri nove senza avvisi.
 */
async function runForUser(
  context: JobContext,
  user: { id: string; email: string },
  counters: JobCounters,
): Promise<void> {
  const { prisma, log, now } = context;

  const occurrences = await occurrenceContext(prisma, user.id, now);
  const today = occurrences.today;

  const sweep = await runSweep(context, user.id, occurrences);
  counters.occurrencesSynced += sweep.occurrencesSynced;
  counters.markedPaid += sweep.markedPaid;
  counters.failures += sweep.failures;

  const reminders = planReminders(await collectReminderInput(prisma, user.id, today));
  counters.remindersPlanned += reminders.length;

  const delivery = await deliverReminders(context, user, today, reminders, sweep.markedPaid);
  counters.emailsSent += delivery.emailsSent;
  counters.notificationsCreated += delivery.notificationsCreated;
  counters.failures += delivery.failures;

  const settings = await prisma.settings.findUnique({
    where: { userId: user.id },
    select: { digestEnabled: true, digestDayOfWeek: true },
  });
  if (settings !== null) {
    const digest = await runDigest(context, user, today, settings);
    counters.emailsSent += digest.sent;
    counters.failures += digest.failures;
  }

  log.debug({ userId: user.id, reminders: reminders.length }, 'Utente elaborato');
}

/**
 * La potatura delle notifiche lette.
 *
 * Solo le **lette**, e solo le notifiche: una non letta è un avviso che nessuno
 * ha ancora visto, e cancellarla sarebbe perdere proprio quella che contava.
 * `ReminderLog` non si pota mai — è la memoria della deduplica, e svuotarla
 * rimanderebbe email già inviate.
 */
async function pruneNotifications(
  context: JobContext,
  counters: JobCounters,
  userId: string | undefined,
): Promise<void> {
  const { prisma, log, now, notificationRetentionDays } = context;
  const cutoff = new Date(now.getTime() - notificationRetentionDays * 86_400_000);

  try {
    const result = await prisma.notification.deleteMany({
      where: { readAt: { not: null, lt: cutoff }, ...(userId === undefined ? {} : { userId }) },
    });
    if (result.count > 0) log.info({ removed: result.count }, 'Notifiche lette potate');
  } catch (error) {
    counters.failures += 1;
    log.warn({ err: error }, 'Potatura delle notifiche fallita');
  }
}

/**
 * A chi si rivolge un giro.
 *
 * `userId` lo restringe a una persona sola. Non è un parametro di comodo per i
 * test: è ciò che serve a `POST /jobs/:name/run`, dove la giustificazione per
 * non chiedere un token di servizio è proprio che l'endpoint «non fa nulla che
 * l'utente non possa già fare sui propri dati». Senza il filtro farebbe molto
 * di più — toccherebbe i dati di tutti gli altri — e quella giustificazione
 * cadrebbe. La pianificazione non lo passa e li prende tutti.
 */
export interface JobOptions {
  userId?: string;
}

export async function runDailyJob(
  context: JobContext,
  options: JobOptions = {},
): Promise<JobResult> {
  const started = Date.now();
  const counters = emptyCounters();

  await syncRates(context, counters);

  // `isActive` è già nel filtro: oggi la tabella ha una riga, ma scriverlo
  // adesso costa tre parole e toglie una riscrittura futura.
  const users = await context.prisma.user.findMany({
    where: { isActive: true, ...(options.userId === undefined ? {} : { id: options.userId }) },
    select: { id: true, email: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const user of users) {
    try {
      await runForUser(context, user, counters);
    } catch (error) {
      counters.failures += 1;
      context.log.error({ err: error, userId: user.id }, 'Giro giornaliero fallito per un utente');
    }
  }

  await pruneNotifications(context, counters, options.userId);

  return { name: 'daily', durationMs: Date.now() - started, counters };
}

export async function runFxJob(context: JobContext): Promise<JobResult> {
  const started = Date.now();
  const counters = emptyCounters();

  await syncRates(context, counters);

  return { name: 'fx', durationMs: Date.now() - started, counters };
}
