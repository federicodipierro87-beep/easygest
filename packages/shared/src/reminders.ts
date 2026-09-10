import { z } from 'zod';

import { formatIsoDate, isoWeekKey } from './recurrence';

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
