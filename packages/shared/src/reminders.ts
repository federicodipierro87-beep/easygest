import { z } from 'zod';

import type { ExpenseStatus, OccurrenceStatus } from './expenses';
import { expiresBefore } from './payment-methods';
import {
  addDays,
  cancellationDeadline,
  differenceInDays,
  formatIsoDate,
  isoWeekKey,
  startOfUtcDay,
} from './recurrence';

/**
 * Generi, canali e chiavi degli avvisi.
 *
 * Un promemoria è un fatto che va detto una volta sola. Dirlo due volte non è
 * un fastidio da poco: chi riceve due email identiche per la stessa scadenza
 * smette di credere ai numeri che ci sono dentro, e da lì a ignorare tutti gli
 * avvisi il passo è breve. La garanzia sta nella **chiave di deduplica**, che è
 * `UNIQUE` in tabella: il database rifiuta il doppione anche se due processi
 * partono insieme, cosa che nessun controllo scritto qui potrebbe fare.
 *
 * Le chiavi si costruiscono solo da qui. Comporle a mano nei punti di chiamata
 * significherebbe che il giorno in cui il formato cambia — e cambiare formato
 * **rimanda tutte le email già inviate**, perché nessuna chiave nuova
 * corrisponde a una riga esistente — bisogna trovarli tutti.
 */

/** Rispecchia l'enum `ReminderKind` di Prisma: i due elenchi devono coincidere. */
export const REMINDER_KINDS = [
  'EXPENSE_DUE',
  'CANCELLATION_WINDOW',
  'CARD_EXPIRING',
  'DOCUMENT_DUE',
  'DIGEST',
] as const;
export const reminderKindSchema = z.enum(REMINDER_KINDS);
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/**
 * I generi che il motore produce davvero.
 *
 * `DOCUMENT_DUE` è dichiarato nello schema ma non ha ancora un produttore: le
 * scadenze dei documenti arrivano con la Fase 7. `DIGEST` non è un promemoria
 * ma un riepilogo, non scatta su un anticipo e non ha una controparte in-app.
 * Tenerli fuori da questo elenco fa sì che un `switch` esaustivo sui generi
 * degli avvisi non debba inventare due rami vuoti.
 */
export const REMINDER_TARGET_KINDS = [
  'EXPENSE_DUE',
  'CANCELLATION_WINDOW',
  'CARD_EXPIRING',
] as const;
export type ReminderTargetKind = (typeof REMINDER_TARGET_KINDS)[number];

/** Le etichette stanno qui e non nel frontend: le usano anche gli oggetti delle email. */
export const REMINDER_KIND_LABELS: Record<ReminderKind, string> = {
  EXPENSE_DUE: 'Scadenza in arrivo',
  CANCELLATION_WINDOW: 'Disdetta in scadenza',
  CARD_EXPIRING: 'Carta in scadenza',
  DOCUMENT_DUE: 'Documento in scadenza',
  DIGEST: 'Riepilogo settimanale',
};

/** Rispecchia l'enum `NotificationChannel` di Prisma. */
export const NOTIFICATION_CHANNELS = ['EMAIL', 'IN_APP'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Quanti giorni prima avvisare che una carta sta per scadere.
 *
 * Costante e non impostazione, a differenza degli anticipi delle scadenze: una
 * carta scade una volta ogni tre o quattro anni, e mettere in pagina un campo
 * che si tocca una volta ogni tre anni costa più di quanto renda. Trenta giorni
 * è il tempo che una banca impiega a spedire la sostitutiva, sette è l'ultimo
 * momento per accorgersi che non è arrivata.
 *
 * Decrescente per somigliare agli anticipi delle impostazioni, che il loro
 * schema normalizza così. La scelta dell'anticipo non dipende dall'ordine —
 * `pickDaysBefore` prende il minimo, non il primo — ma due liste che si leggono
 * nello stesso verso si confrontano a occhio senza pensarci.
 */
export const CARD_EXPIRING_DAYS_BEFORE: readonly number[] = [30, 7];

/**
 * La grammatica delle chiavi: `GENERE:soggetto:qualificatore:CANALE`.
 *
 * Il canale sta **sempre** in fondo. Metterlo in mezzo funzionerebbe uguale per
 * il database, ma un `LIKE 'EXPENSE_DUE:%'` durante un'indagine in produzione
 * smetterebbe di essere leggibile, e queste righe si guardano proprio così: a
 * mano, quando qualcuno dice «non mi è arrivata l'email».
 */
function joinKey(parts: readonly (string | number)[]): string {
  return parts.map(String).join(':');
}

/**
 * `EXPENSE_DUE:<occurrenceId>:<anticipo>:<CANALE>`.
 *
 * Ancorata all'**occorrenza** e non alla spesa. È la scelta giusta perché
 * cambiare la ricorrenza rigenera le occorrenze future, cioè produce identità
 * nuove: se una spesa mensile diventa trimestrale, le scadenze che ne nascono
 * sono altre scadenze e meritano il loro avviso. Con la spesa come soggetto
 * resterebbero mute fino all'anno dopo.
 */
export function expenseDueKey(
  occurrenceId: string,
  daysBefore: number,
  channel: NotificationChannel,
): string {
  return joinKey(['EXPENSE_DUE', occurrenceId, daysBefore, channel]);
}

/** `CANCELLATION_WINDOW:<occurrenceId>:<anticipo>:<CANALE>`, stessa ancora. */
export function cancellationWindowKey(
  occurrenceId: string,
  daysBefore: number,
  channel: NotificationChannel,
): string {
  return joinKey(['CANCELLATION_WINDOW', occurrenceId, daysBefore, channel]);
}

/**
 * `CARD_EXPIRING:<paymentMethodId>:<AAAA-MM>:<anticipo>:<CANALE>`.
 *
 * Porta anche il mese di scadenza, che le altre due non hanno bisogno di
 * portare. Senza, correggere una carta da 03/2027 a 03/2029 — cioè registrare
 * la sostitutiva sulla stessa riga, che è quello che si fa — non produrrebbe
 * mai più un avviso: le chiavi sarebbero quelle già usate.
 *
 * Il mese arriva come due numeri e non come una data, perché il riferimento
 * dell'avviso è l'ultimo giorno **valido** — il 31 marzo — mentre il campo
 * naturale da cui si passa è `expiresBefore`, che è il 1° aprile. Prendere una
 * `Date` renderebbe indistinguibili due chiamate che producono chiavi diverse.
 */
export function cardExpiringKey(
  paymentMethodId: string,
  expiry: { month: number; year: number },
  daysBefore: number,
  channel: NotificationChannel,
): string {
  const month = `${String(expiry.year).padStart(4, '0')}-${String(expiry.month).padStart(2, '0')}`;
  return joinKey(['CARD_EXPIRING', paymentMethodId, month, daysBefore, channel]);
}

/**
 * `EXPENSE_DUE:autopaid:<userId>:<AAAA-MM-GG>:IN_APP`.
 *
 * L'avviso che il cron ha marcato pagate delle scadenze da solo. Il soggetto è
 * l'utente e il qualificatore è il giorno del giro, perché la notifica è una
 * sola e raggruppata: N scadenze in una riga, non N righe. Il genere è
 * `EXPENSE_DUE` per mancanza di meglio nell'enum, e `autopaid` come primo pezzo
 * la tiene distinta dalle chiavi degli avvisi veri, che lì hanno un `cuid`.
 *
 * Solo in-app: un'email per dire «ho fatto il mio lavoro» è rumore, ma la riga
 * in elenco serve, perché è da lì che si arriva alle scadenze da confermare.
 */
export function autoPaidKey(userId: string, day: Date): string {
  return joinKey(['EXPENSE_DUE', 'autopaid', userId, formatIsoDate(day), 'IN_APP']);
}

/**
 * `DIGEST:<userId>:<AAAA-Www>:EMAIL`.
 *
 * Settimana ISO e non data: con la data, spostare `digestDayOfWeek` da lunedì a
 * mercoledì manderebbe due riepiloghi nella stessa settimana, e chi ha appena
 * cambiato l'impostazione penserebbe di averla rotta.
 */
export function digestKey(userId: string, day: Date): string {
  return joinKey(['DIGEST', userId, isoWeekKey(day), 'EMAIL']);
}

/**
 * Il motore dei promemoria.
 *
 * Puro come `recurrence.ts`, e per la stessa ragione: non conosce Prisma e non
 * legge l'orologio. «Oggi» entra come parametro, le righe del database entrano
 * già ridotte alle poche colonne che contano. Il collegamento sta in
 * `apps/api/src/jobs/collect.ts`, che fa le query e riempie queste viste.
 *
 * La conseguenza pratica è che l'unica cosa difficile della fase — quando
 * scatta un avviso, e con quale identità — si prova senza database, senza rete
 * e senza aspettare le sette del mattino.
 */

/**
 * Un'occorrenza vista dal motore, con quel poco che serve della sua spesa.
 *
 * Le colonne della spesa sono annidate e non appiattite perché le tre regole
 * della disdetta parlano tutte di lei: `expense.autoRenew` si legge come una
 * frase, `expenseAutoRenew` come un campo copiato.
 */
export interface OccurrenceView {
  id: string;
  dueDate: Date;
  status: OccurrenceStatus;
  grossCents: number;
  currency: string;
  expenseId: string;
  expenseName: string;
  expense: {
    status: ExpenseStatus;
    autoRenew: boolean;
    cancellationNoticeDays: number | null;
    cancelledAt: Date | null;
  };
}

/**
 * Un metodo di pagamento visto dal motore.
 *
 * `activeExpenseCount` non è una colonna: è una `count` che fa `collect.ts`. Sta
 * qui perché senza, la regola «niente avvisi per una carta che non paga più
 * niente» finirebbe nella query, cioè in un posto che i test puri non vedono.
 */
export interface PaymentMethodView {
  id: string;
  label: string;
  expiryMonth: number | null;
  expiryYear: number | null;
  isActive: boolean;
  activeExpenseCount: number;
}

/** I due elenchi di anticipi, presi da `Settings`. */
export interface ReminderSettingsView {
  reminderDaysBefore: readonly number[];
  cancellationReminderDaysBefore: readonly number[];
}

export interface PlanRemindersInput {
  /** Il giorno di riferimento, già nel fuso dell'utente. */
  today: Date;
  settings: ReminderSettingsView;
  occurrences: readonly OccurrenceView[];
  paymentMethods: readonly PaymentMethodView[];
}

/**
 * Un avviso da dare, con la sua identità già calcolata.
 *
 * Porta gli identificativi grezzi e non un link o un `entityType`: quelli sono
 * decisioni di presentazione, e metterli qui legherebbe il motore alle rotte
 * del frontend. Chi consegna li deriva dal genere.
 */
export interface PlannedReminder {
  kind: ReminderTargetKind;
  /** Come si chiama la cosa di cui si parla: il nome della spesa, l'etichetta della carta. */
  label: string;
  /** Il giorno su cui si conta l'anticipo: la scadenza, il termine di disdetta, l'ultimo giorno valido. */
  referenceDate: Date;
  /** Il giorno del rinnovo, quando il riferimento è un'altra cosa. Serve al testo della disdetta. */
  dueDate: Date | null;
  /** L'anticipo scelto, cioè il qualificatore della chiave. */
  daysBefore: number;
  /** Quanti giorni mancano davvero, che è ciò che si scrive nel testo. */
  daysRemaining: number;

  occurrenceId: string | null;
  expenseId: string | null;
  paymentMethodId: string | null;

  grossCents: number | null;
  currency: string | null;

  /** Le due chiavi di deduplica, una per canale. */
  keys: Record<NotificationChannel, string>;
}

/**
 * Quale anticipo far scattare, fra quelli configurati.
 *
 * **Il più piccolo che sia ancora maggiore o uguale ai giorni che mancano.**
 * Con `[30, 7, 1]` e nove giorni alla scadenza si sceglie 7, non 30 e non 1.
 *
 * Le due alternative ovvie sono entrambe sbagliate. «Tutti quelli che
 * soddisfano» manderebbe tre email nello stesso istante per una spesa inserita
 * due giorni prima di scadere, che è il modo più rapido di insegnare a ignorare
 * gli avvisi. «Esattamente uguale» perderebbe il promemoria per sempre se il
 * processo è spento quel giorno — e i processi si spengono, un deploy dura un
 * minuto e il giro è uno al giorno.
 *
 * Con il minimo applicabile un giro saltato si fonde nel successivo: chi doveva
 * ricevere l'avviso a 30 giorni e non l'ha ricevuto lo riceve a 29, con la
 * stessa chiave, quindi una volta sola. E quando si scende sotto il gradino
 * successivo la chiave cambia, quindi il secondo avviso parte comunque.
 *
 * `null` significa «non ancora» oppure «non più»: entrambi i casi sono silenzio,
 * e distinguerli non servirebbe a niente perché il chiamante farebbe lo stesso.
 * Il «non più» copre anche le scadute, che non ricevono avvisi — un promemoria
 * per qualcosa che è già passato non è un'azione, è un rimprovero — e compaiono
 * invece nel riepilogo settimanale, dove il tono è quello di un elenco.
 */
export function pickDaysBefore(
  daysRemaining: number,
  configured: readonly number[],
): number | null {
  if (daysRemaining < 0) return null;

  let chosen: number | null = null;
  for (const days of configured) {
    if (!Number.isInteger(days) || days < 0) continue;
    if (days < daysRemaining) continue;
    if (chosen === null || days < chosen) chosen = days;
  }
  return chosen;
}

/**
 * La prima occorrenza ancora prevista di ogni spesa.
 *
 * Serve alla sola disdetta, e senza questo vincolo un mensile con sessanta
 * giorni di preavviso ne farebbe scattare due o tre insieme: la finestra di
 * disdetta di marzo, quella di aprile e quella di maggio sono tutte aperte
 * contemporaneamente. Ma la disdetta si manda una volta e vale per il
 * contratto, non per la singola rata.
 */
function firstPlannedPerExpense(occurrences: readonly OccurrenceView[]): OccurrenceView[] {
  const first = new Map<string, OccurrenceView>();
  for (const occurrence of occurrences) {
    if (occurrence.status !== 'PLANNED') continue;
    const known = first.get(occurrence.expenseId);
    if (known === undefined || occurrence.dueDate < known.dueDate) {
      first.set(occurrence.expenseId, occurrence);
    }
  }
  return [...first.values()];
}

/**
 * L'ultimo giorno in cui la carta funziona ancora.
 *
 * `expiresBefore` dà il primo giorno in cui **non** funziona più, cioè il primo
 * del mese successivo: una carta 03/2027 è valida per tutto marzo. Il giorno
 * prima è quello su cui si conta l'anticipo.
 */
export function lastValidDay(expiryMonth: number, expiryYear: number): Date {
  return addDays(expiresBefore(expiryMonth, expiryYear), -1);
}

/**
 * Le due chiavi di un avviso, dalla funzione che ne costruisce una.
 *
 * Ogni avviso viaggia su due canali e produce due `ReminderLog` distinti: se le
 * chiavi coincidessero, la seconda scrittura fallirebbe per doppione e uno dei
 * due canali resterebbe muto senza che nessuno se ne accorga.
 */
function bothChannels(build: (channel: NotificationChannel) => string): Record<
  NotificationChannel,
  string
> {
  return { EMAIL: build('EMAIL'), IN_APP: build('IN_APP') };
}

/**
 * Tutti gli avvisi che oggi meritano di partire, per un utente.
 *
 * Non filtra i doppioni: dice cosa scatterebbe, e se sia già stato detto lo sa
 * solo il database. È deliberato — la deduplica è un vincolo `UNIQUE`, non un
 * controllo, perché due giri in parallelo leggerebbero entrambi una tabella
 * senza la riga e proverebbero entrambi a scriverla.
 *
 * L'ordine dell'uscita è stabile: prima le date più vicine, poi il genere, poi
 * il nome. Serve al testo dell'email, che è uno solo per genere e li elenca in
 * fila, e serve ai test, che altrimenti dipenderebbero dall'ordine in cui
 * Postgres ha restituito le righe.
 */
export function planReminders(input: PlanRemindersInput): PlannedReminder[] {
  const today = startOfUtcDay(input.today);
  const planned: PlannedReminder[] = [];

  for (const occurrence of input.occurrences) {
    // Una pagata, saltata o annullata non ha più niente da ricordare. Lo stato
    // della spesa non si guarda: se l'occorrenza è ancora prevista va pagata,
    // qualunque cosa sia successo nel frattempo al contratto che l'ha generata.
    if (occurrence.status !== 'PLANNED') continue;

    const daysRemaining = differenceInDays(today, occurrence.dueDate);
    const daysBefore = pickDaysBefore(daysRemaining, input.settings.reminderDaysBefore);
    if (daysBefore === null) continue;

    planned.push({
      kind: 'EXPENSE_DUE',
      label: occurrence.expenseName,
      referenceDate: occurrence.dueDate,
      dueDate: occurrence.dueDate,
      daysBefore,
      daysRemaining,
      occurrenceId: occurrence.id,
      expenseId: occurrence.expenseId,
      paymentMethodId: null,
      grossCents: occurrence.grossCents,
      currency: occurrence.currency,
      keys: bothChannels((channel) => expenseDueKey(occurrence.id, daysBefore, channel)),
    });
  }

  for (const occurrence of firstPlannedPerExpense(input.occurrences)) {
    const { expense } = occurrence;
    // Quattro condizioni, tutte necessarie. Le prime tre dicono che c'è
    // qualcosa da disdire; la quarta che non è già stato fatto — insistere su
    // una disdetta già inviata sarebbe peggio del silenzio, perché lascia il
    // dubbio di non averla mandata davvero.
    if (expense.status !== 'ACTIVE') continue;
    if (!expense.autoRenew) continue;
    if (expense.cancellationNoticeDays === null) continue;
    if (expense.cancelledAt !== null) continue;

    const deadline = cancellationDeadline(occurrence.dueDate, expense.cancellationNoticeDays);
    if (deadline === null) continue;

    const daysRemaining = differenceInDays(today, deadline);
    const daysBefore = pickDaysBefore(
      daysRemaining,
      input.settings.cancellationReminderDaysBefore,
    );
    if (daysBefore === null) continue;

    planned.push({
      kind: 'CANCELLATION_WINDOW',
      label: occurrence.expenseName,
      referenceDate: deadline,
      dueDate: occurrence.dueDate,
      daysBefore,
      daysRemaining,
      occurrenceId: occurrence.id,
      expenseId: occurrence.expenseId,
      paymentMethodId: null,
      grossCents: occurrence.grossCents,
      currency: occurrence.currency,
      keys: bothChannels((channel) => cancellationWindowKey(occurrence.id, daysBefore, channel)),
    });
  }

  for (const method of input.paymentMethods) {
    if (!method.isActive) continue;
    if (method.expiryMonth === null || method.expiryYear === null) continue;
    // Una carta che non paga più niente non è un problema, e avvisare per essa
    // insegna a ignorare gli avvisi. Il conteggio è delle spese attive, non di
    // tutte: una carta agganciata solo a contratti già disdetti è nella stessa
    // condizione di una carta libera.
    if (method.activeExpenseCount === 0) continue;

    const expiry = { month: method.expiryMonth, year: method.expiryYear };
    const reference = lastValidDay(expiry.month, expiry.year);
    const daysRemaining = differenceInDays(today, reference);
    const daysBefore = pickDaysBefore(daysRemaining, CARD_EXPIRING_DAYS_BEFORE);
    if (daysBefore === null) continue;

    planned.push({
      kind: 'CARD_EXPIRING',
      label: method.label,
      referenceDate: reference,
      dueDate: null,
      daysBefore,
      daysRemaining,
      occurrenceId: null,
      expenseId: null,
      paymentMethodId: method.id,
      grossCents: null,
      currency: null,
      keys: bothChannels((channel) => cardExpiringKey(method.id, expiry, daysBefore, channel)),
    });
  }

  return planned.sort(
    (a, b) =>
      a.referenceDate.getTime() - b.referenceDate.getTime() ||
      a.kind.localeCompare(b.kind) ||
      a.label.localeCompare(b.label, 'it'),
  );
}
