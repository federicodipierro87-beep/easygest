import {
  addDays,
  centsToDecimalString,
  differenceInDays,
  formatCents,
  formatIsoDate,
  parseAmountToCents,
  parseIsoDate,
} from '@easygest/shared';

/**
 * Come si scrivono e come si leggono le caselle dei moduli.
 *
 * Quasi niente qui è nuovo: gli importi li sanno già fare `money.ts` e le date
 * `recurrence.ts`, e riscriverli vorrebbe dire avere due arrotondamenti e due
 * idee di cosa sia il 29 febbraio. Questo modulo li avvolge e aggiunge le due
 * cose che mancavano davvero.
 *
 * La prima è la lettura di una casella. `parseAmountToCents` restituisce `null`
 * sia per «vuota» sia per «dodici e cinquanta», e sono due cose diverse: la
 * prima è legittima — l'imponibile si può omettere se c'è il totale — la
 * seconda è un errore da mostrare sotto il campo. I tre `parse*` distinguono
 * `null` da `'invalido'` proprio per questo.
 *
 * La seconda sono le date, e in particolare la differenza fra un giorno di
 * calendario e un istante, che qui non è una sottigliezza: `2027-03-15` letto
 * come `Date` è mezzanotte UTC, e a ovest di Greenwich
 * `new Date('2027-03-15').toLocaleDateString('it-IT')` stampa il **14**. Per
 * questo `formatDay` lavora sulla stringa e non la converte mai in un `Date`,
 * mentre `formatInstant` parte da un `Date` vero — `paidAt` *è* un istante, e
 * mostrarlo nel fuso di chi guarda è la cosa giusta.
 */

/** Quando non c'è niente da mostrare. Una casella vuota è più muta di un vuoto. */
const DASH = '—';

/**
 * `2027-03-15` → `15/03/2027`, senza passare da un `Date`.
 *
 * Accetta anche un istante ISO completo e ne prende la parte di data così
 * com'è: se il server ha mandato un giorno di calendario dentro un timestamp,
 * il giorno giusto è quello scritto, non quello che uscirebbe convertendolo.
 */
export function formatDay(iso: string | null | undefined): string {
  if (iso == null || iso === '') return DASH;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return iso;
  const [, year = '', month = '', day = ''] = match;
  return `${day}/${month}/${year}`;
}

/** Un istante, nel fuso di chi guarda: `15/03/2027, 14:32`. */
export function formatInstant(iso: string | null | undefined): string {
  if (iso == null || iso === '') return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Un importo con il suo simbolo: `1.234,56 €`. */
export function formatMoney(cents: number, currency = 'EUR'): string {
  return formatCents(cents, { currency });
}

/**
 * Oggi per chi guarda, non per il server.
 *
 * I getter sono quelli locali di proposito: le scadenze sono giorni di
 * calendario, e a mezzanotte e mezza a Roma in UTC è ancora ieri. Con i getter
 * UTC una scadenza dovuta oggi risulterebbe futura per mezz'ora ogni notte, e
 * in estate per un'ora e mezza.
 */
export function todayIso(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Lo stesso giorno spostato di `days`, restituito nella stessa forma. */
export function isoPlusDays(iso: string, days: number): string {
  const day = parseIsoDate(iso);
  return day === null ? iso : formatIsoDate(addDays(day, days));
}

/**
 * Quanti giorni mancano a `iso`. Negativo se è passato, `null` se non è una data.
 */
export function daysUntil(iso: string, today: string = todayIso()): number | null {
  const from = parseIsoDate(today);
  const to = parseIsoDate(iso);
  if (from === null || to === null) return null;
  return differenceInDays(from, to);
}

/**
 * La distanza da oggi detta a parole.
 *
 * «fra 47 giorni» è più utile di «01/05/2027» accanto alla data, che c'è già:
 * la domanda che si fa guardando un elenco di scadenze è «quanto manca», e
 * contare i giorni a mente da un calendario è precisamente il lavoro che
 * l'applicazione dovrebbe togliere.
 */
export function describeDue(iso: string, today: string = todayIso()): string {
  const days = daysUntil(iso, today);
  if (days === null) return '';
  if (days === 0) return 'oggi';
  if (days === 1) return 'domani';
  if (days === -1) return 'ieri';
  if (days > 0) return `fra ${String(days)} giorni`;
  return `${String(-days)} giorni fa`;
}

/**
 * Il valore di una casella numerica.
 *
 * `null` è la casella vuota, che spesso è legittima; `'invalido'` è quello che
 * l'utente ha scritto e che non è un numero. Il server non può distinguerli —
 * riceve `netCents: null` in entrambi i casi — ed è il motivo per cui questo è
 * l'unico controllo che il client fa da sé.
 */
export type ParsedNumber = number | null | 'invalido';

/** `1.234,56` → `123456`. */
export function parseEuro(raw: string): ParsedNumber {
  if (raw.trim() === '') return null;
  const cents = parseAmountToCents(raw);
  return cents === null ? 'invalido' : cents;
}

/**
 * `22,5%` → `2250` basis point.
 *
 * È la stessa trasformazione di `22,50 €` → `2250` centesimi, e usa la stessa
 * funzione: due cifre decimali su una base intera. Riscriverla vorrebbe dire
 * avere due idee di cosa sia `1.234` — che in Italia sono milleduecento
 * trentaquattro e in inglese uno virgola due tre quattro.
 */
export function parsePercent(raw: string): ParsedNumber {
  return parseEuro(raw.replace('%', ''));
}

/** Un conteggio: giorni di preavviso, intervallo di ricorrenza. */
export function parseInteger(raw: string): ParsedNumber {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return 'invalido';
  return Number(trimmed);
}

/** L'inverso di `parseEuro`: `123456` → `1234,56`, da mettere in una casella. */
export function euroFromCents(cents: number | null | undefined): string {
  if (cents == null) return '';
  return centsToDecimalString(cents).replace('.', ',');
}

/** L'inverso di `parsePercent`: `2250` → `22,50`. */
export function percentFromBasisPoints(bp: number | null | undefined): string {
  return euroFromCents(bp);
}
