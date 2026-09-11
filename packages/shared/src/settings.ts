import { z } from 'zod';

import { isValidTimeZone } from './recurrence';

/**
 * Le preferenze dell'utente: fisco, valuta, fuso, avvisi.
 *
 * Sono una riga sola per utente, ma non un unico oggetto modificabile in blocco.
 * `GET` restituisce tutto — alla Fase 6 servirà il blocco fiscale intero per
 * calcolare le imposte — mentre `PATCH` accetta solo i campi degli avvisi, che
 * sono gli unici che questa fase sa salvare senza rompere nulla a valle.
 */

export const taxRegimeSchema = z.enum(['FORFETTARIO', 'ORDINARIO']);
export type TaxRegime = z.infer<typeof taxRegimeSchema>;

export const TAX_REGIME_LABELS: Record<TaxRegime, string> = {
  FORFETTARIO: 'Forfettario',
  ORDINARIO: 'Ordinario',
};

/**
 * La riga come esce dall'API.
 *
 * `baseCurrency` c'è ma non si cambia, e vale la pena dire perché: il cambio
 * viene congelato su ogni occorrenza nel momento in cui matura, quindi i
 * `baseGrossCents` già scritti sono espressi nella valuta di allora. Cambiarla
 * a metà strada non riconvertirebbe lo storico — lo renderebbe semplicemente
 * incomparabile, senza che nessun errore lo segnali.
 */
export interface Settings {
  taxRegime: TaxRegime;
  substituteTaxRateBp: number;
  profitabilityCoefficientBp: number;
  inpsRateBp: number;
  defaultVatRateBp: number;
  baseCurrency: string;
  timezone: string;
  reminderDaysBefore: number[];
  cancellationReminderDaysBefore: number[];
  digestEnabled: boolean;
  digestDayOfWeek: number;
  updatedAt: string;
}

/** Quanti anticipi diversi si possono configurare per un singolo genere. */
export const MAX_REMINDER_DAYS_BEFORE = 6;

/**
 * Lista di anticipi, normalizzata.
 *
 * Il `transform` toglie i doppioni e ordina dal più lontano al più vicino, ed è
 * la parte che conta: `[7, 30, 7]` e `[30, 7]` sono la stessa configurazione, ma
 * salvate diverse produrrebbero due insiemi di chiavi di deduplica per gli
 * stessi avvisi — e chi ha scritto il doppione riceverebbe l'email due volte
 * senza capire perché. Normalizzare qui, una volta, vale più di qualunque
 * controllo a valle.
 *
 * La lista vuota è ammessa di proposito: è il modo di spegnere quel genere di
 * promemoria. Un interruttore separato direbbe la stessa cosa con un campo in
 * più.
 */
function daysBeforeSchema(max: number) {
  return z
    .array(
      z
        .number()
        .int('Servono giorni interi')
        .min(0, 'I giorni non possono essere negativi')
        .max(max, `Il massimo è ${String(max)} giorni`),
    )
    .max(MAX_REMINDER_DAYS_BEFORE, `Non più di ${String(MAX_REMINDER_DAYS_BEFORE)} anticipi`)
    .transform((days) => [...new Set(days)].sort((a, b) => b - a));
}

export const timezoneSchema = z
  .string()
  .trim()
  .min(1, 'Il fuso è obbligatorio')
  .refine(isValidTimeZone, 'Fuso orario sconosciuto');

/**
 * Il giorno del riepilogo, 1 = lunedì come ISO-8601.
 *
 * Coincide con `isoWeekday`, che è quello con cui il giro giornaliero decide se
 * oggi tocca: usare la convenzione di `getUTCDay`, con la domenica a zero,
 * significherebbe convertire avanti e indietro in due punti diversi.
 */
export const digestDayOfWeekSchema = z
  .number()
  .int()
  .min(1, 'Giorno non valido')
  .max(7, 'Giorno non valido');

/**
 * Cosa si può cambiare.
 *
 * `strictObject` e non `object`: un campo scritto male — `digestDay` invece di
 * `digestDayOfWeek` — verrebbe ignorato in silenzio, e l'utente vedrebbe un
 * salvataggio riuscito che non ha salvato niente.
 *
 * Il tetto dei preavvisi di disdetta è 730 e non 365 per coerenza con
 * `cancellationNoticeDays` sulla spesa: se si può registrare un contratto con
 * due anni di preavviso, si deve poter chiedere di esserne avvisati.
 */
export const settingsPatchSchema = z
  .strictObject({
    timezone: timezoneSchema,
    reminderDaysBefore: daysBeforeSchema(365),
    cancellationReminderDaysBefore: daysBeforeSchema(730),
    digestEnabled: z.boolean(),
    digestDayOfWeek: digestDayOfWeekSchema,
  })
  .partial();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DIGEST_DAY_LABELS: Record<number, string> = {
  1: 'Lunedì',
  2: 'Martedì',
  3: 'Mercoledì',
  4: 'Giovedì',
  5: 'Venerdì',
  6: 'Sabato',
  7: 'Domenica',
};

/**
 * I fusi che una tendina può mostrare.
 *
 * Sono nove e non seicento. `Intl.supportedValuesOf('timeZone')` li darebbe
 * tutti, ma una tendina con seicento voci, per un utente che ne ha una sola
 * corretta, è più difficile da usare di un campo di testo. Chi ha bisogno di
 * un fuso fuori da questa lista lo ha già salvato — via seed o via API — e
 * l'interfaccia deve aggiungere il valore corrente in coda invece di
 * sostituirlo con il primo della lista.
 */
export const TIMEZONE_CHOICES: readonly string[] = [
  'Europe/Rome',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Lisbon',
  'Europe/Zurich',
  'America/New_York',
  'UTC',
];

/**
 * Gli anticipi come si scrivono in una casella di testo, e viceversa.
 *
 * Un editor a chip sarebbe più bello, ma è molto componente per un campo che
 * si tocca due volte l'anno; e la coppia di funzioni qui sotto si può buttare
 * senza toccare l'API il giorno in cui lo si scrive davvero.
 */
export function formatDaysBefore(days: readonly number[]): string {
  return days.join(', ');
}

/**
 * Torna `null` se la stringa non è una lista di numeri.
 *
 * Non lancia e non ripara: `30, sette` non è «trenta», è un errore di
 * battitura che l'utente deve vedere prima di salvare.
 */
export function parseDaysBefore(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (trimmed === '') return [];

  const parsed: number[] = [];
  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (!/^\d+$/.test(piece)) return null;
    parsed.push(Number(piece));
  }
  return parsed;
}
