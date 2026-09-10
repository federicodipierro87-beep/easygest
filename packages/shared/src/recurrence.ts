import { z } from 'zod';

/**
 * Il calendario delle ricorrenze.
 *
 * Tutto qui dentro è puro: nessuna funzione legge l'orologio. «Oggi» entra
 * sempre come parametro, perché un motore che chiama `Date.now()` al proprio
 * interno si può provare solo il giorno giusto dell'anno giusto — e la regola
 * più delicata di questo file, il 29 febbraio, capita una volta ogni quattro.
 *
 * Un giorno di calendario è rappresentato come un `Date` a mezzanotte UTC. Le
 * colonne corrispondenti sono `@db.Date`, cioè giorni senza ora: usare l'ora
 * locale significherebbe che la stessa scadenza cade il 30 o il 31 a seconda
 * di dove gira il processo, e il cron gira su Railway, non a Roma.
 */

export const RECURRENCE_UNITS = ['ONE_OFF', 'DAY', 'WEEK', 'MONTH', 'YEAR'] as const;
export const recurrenceUnitSchema = z.enum(RECURRENCE_UNITS);
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];

export const RECURRENCE_UNIT_LABELS: Record<RecurrenceUnit, string> = {
  ONE_OFF: 'Una tantum',
  DAY: 'Giornaliera',
  WEEK: 'Settimanale',
  MONTH: 'Mensile',
  YEAR: 'Annuale',
};

/**
 * Quanto avanti si materializzano le occorrenze di un abbonamento perpetuo.
 *
 * Tredici mesi e non dodici: con dodici, il rinnovo annuale del 15 marzo
 * sarebbe l'ultimo giorno dell'orizzonte per un attimo solo, e la finestra di
 * disdetta — che si apre sessanta giorni prima — resterebbe scoperta nella
 * finestra fra una rigenerazione e la successiva. Il tredicesimo mese è il
 * margine che rende il promemoria di disdetta sempre appendibile a
 * un'occorrenza che esiste già.
 */
export const DEFAULT_HORIZON_MONTHS = 13;

/**
 * Tetto al numero di occorrenze generate in una volta.
 *
 * Non è una scelta di dominio ma una cintura di sicurezza: un intervallo
 * giornaliero con un `endDate` a vent'anni produrrebbe settemila righe senza
 * che nessuno l'abbia chiesto. Superarlo è un errore, non un troncamento
 * silenzioso, perché una serie tagliata a metà è peggio di una che non c'è.
 */
export const MAX_OCCURRENCES = 1000;

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceError';
  }
}

const MS_PER_DAY = 86_400_000;

/** Giorno di calendario a partire dai suoi tre numeri, a mezzanotte UTC. */
export function utcDay(year: number, month1to12: number, day: number): Date {
  const date = new Date(Date.UTC(2000, 0, 1));
  // `Date.UTC` mappa gli anni a due cifre sul Novecento: `Date.UTC(99, 0, 1)`
  // è il 1999. Qui non capiterebbe, ma passare dai setter toglie il dubbio
  // invece di lasciarlo come nota a piè di pagina.
  date.setUTCFullYear(year, month1to12 - 1, day);
  return date;
}

/** Azzera l'ora, tenendo il giorno che il `Date` indica **in UTC**. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** `2027-03-15`, la forma che viaggia in JSON e in SQL. */
export function formatIsoDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Legge `2027-03-15`, e rifiuta `2027-02-30`.
 *
 * `new Date('2027-02-30')` non è un errore in JavaScript: scivola al 2 marzo.
 * Qui una data inesistente deve restare inesistente, quindi il risultato viene
 * riformattato e confrontato con l'ingresso.
 */
export function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year = '', month = '', day = ''] = match;
  const date = utcDay(Number(year), Number(month), Number(day));
  return formatIsoDate(date) === value.trim() ? date : null;
}

/**
 * Un giorno di calendario in ingresso, come `2027-03-15`.
 *
 * Accetta anche un `Date` già pronto, perché il seed e i test costruiscono gli
 * oggetti direttamente mentre l'API riceve stringhe: due schemi per la stessa
 * cosa si sarebbero disallineati alla prima modifica.
 */
export const isoDateSchema = z.union([
  z.string().transform((value, ctx) => {
    const parsed = parseIsoDate(value);
    if (parsed === null) {
      ctx.addIssue({ code: 'custom', message: `Data non valida: «${value}», attesa 2027-03-15` });
      return z.NEVER;
    }
    return parsed;
  }),
  z.date().transform(startOfUtcDay),
]);

/**
 * Il giorno che è «oggi» per l'utente, non per il server.
 *
 * A mezzanotte e mezza a Roma in UTC è ancora ieri. Dato che le scadenze sono
 * giorni di calendario, la differenza si vede: un'occorrenza dovuta oggi
 * risulterebbe futura per mezz'ora ogni notte, e in estate per un'ora e mezza.
 */
export function todayIn(timeZone: string, now: Date): Date {
  // `en-CA` è la scorciatoia per ottenere `YYYY-MM-DD` da `Intl` senza
  // ricomporre i pezzi a mano.
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const parsed = parseIsoDate(iso);
  if (parsed === null) {
    throw new RecurrenceError(`Fuso orario non utilizzabile: ${timeZone}`);
  }
  return parsed;
}

/**
 * Il fuso è utilizzabile?
 *
 * Prova a costruire un formattatore e guarda se esplode. `Intl.supportedValuesOf`
 * sarebbe più severo, ma alloca seicento stringhe a ogni chiamata e rifiuta
 * `UTC`, che è un fuso legittimo e quello con cui gira il container. Il
 * `try/catch` accetta esattamente ciò che poi funzionerà in `todayIn`, che è
 * l'unica proprietà che serve davvero: validare qui e fallire là sarebbe la
 * combinazione peggiore.
 */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function addDays(date: Date, days: number): Date {
  return new Date(startOfUtcDay(date).getTime() + days * MS_PER_DAY);
}

/** Giorno della settimana ISO: 1 è lunedì, 7 è domenica. */
export function isoWeekday(date: Date): number {
  const day = startOfUtcDay(date).getUTCDay();
  // `getUTCDay` mette la domenica a zero; ISO 8601 la mette in fondo.
  return day === 0 ? 7 : day;
}

/**
 * La settimana ISO come `2027-W01`, chiave stabile per il riepilogo.
 *
 * Serve al digest, che dev'essere mandato una volta a settimana e non una volta
 * al giorno: con la data come chiave, spostare il giorno del riepilogo da lunedì
 * a mercoledì ne farebbe partire due nella stessa settimana.
 *
 * L'anno della settimana non è sempre l'anno della data, ed è la ragione per cui
 * questa funzione esiste invece di un `getUTCFullYear()` in linea. Il 1° gennaio
 * 2027 è un venerdì e appartiene alla settimana 53 del **2026**; il 31 dicembre
 * 2029 è un lunedì e appartiene alla settimana 1 del **2030**. La regola ISO è
 * che una settimana appartiene all'anno in cui cade il suo giovedì, e da lì si
 * conta: il giovedì della settimana della data, poi quanti giorni lo separano
 * dal primo giorno di quell'anno.
 */
export function isoWeekKey(date: Date): string {
  const thursday = addDays(date, 4 - isoWeekday(date));
  const year = thursday.getUTCFullYear();
  const week = Math.floor(differenceInDays(utcDay(year, 1, 1), thursday) / 7) + 1;
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

/** Differenza in giorni interi fra due giorni di calendario. */
export function differenceInDays(from: Date, to: Date): number {
  return Math.round((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / MS_PER_DAY);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Somma mesi tenendo il giorno, o il più vicino che esiste.
 *
 * Il 31 gennaio più un mese è il 28 febbraio, perché il 31 febbraio non c'è.
 * Il punto è che questo troncamento **non si accumula**: chi chiama passa
 * sempre la distanza dall'ancora, mai un mese alla volta. Sommando a catena il
 * 31 gennaio diventerebbe 28 febbraio e poi 28 marzo; dall'ancora, due mesi
 * dopo il 31 gennaio è il 31 marzo, che è la data su cui il fornitore addebita.
 */
export function addMonths(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const monthIndex = anchor.getUTCMonth();
  const day = anchor.getUTCDate();

  const absoluteMonth = monthIndex + months;
  const targetYear = year + Math.floor(absoluteMonth / 12);
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;

  return utcDay(targetYear, targetMonth + 1, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

function assertPositiveInterval(interval: number): void {
  if (!Number.isInteger(interval) || interval < 1) {
    throw new RecurrenceError(
      `L'intervallo dev'essere un intero positivo, ricevuto ${String(interval)}`,
    );
  }
}

/**
 * La data dell'occorrenza numero `index`, contando da zero.
 *
 * Sempre calcolata dall'ancora, mai dalla precedente: è la regola che fa
 * tornare il 31 marzo di cui sopra, ed è anche ciò che rende la funzione
 * indipendente dall'ordine in cui la si chiama.
 */
export function occurrenceDate(
  start: Date,
  unit: RecurrenceUnit,
  interval: number,
  index: number,
): Date {
  if (!Number.isInteger(index) || index < 0) {
    throw new RecurrenceError(
      `L'indice dev'essere un intero non negativo, ricevuto ${String(index)}`,
    );
  }
  const anchor = startOfUtcDay(start);
  if (unit === 'ONE_OFF') {
    if (index > 0) {
      throw new RecurrenceError('Una spesa una tantum ha una sola occorrenza');
    }
    return anchor;
  }
  assertPositiveInterval(interval);

  switch (unit) {
    case 'DAY':
      return addDays(anchor, index * interval);
    case 'WEEK':
      return addDays(anchor, index * interval * 7);
    case 'MONTH':
      return addMonths(anchor, index * interval);
    case 'YEAR':
      return addMonths(anchor, index * interval * 12);
  }
}

/**
 * Il primo indice la cui data cade a `target` o dopo.
 *
 * Serve a non contare da zero. Una spesa giornaliera aperta cinque anni fa ha
 * milleottocento occorrenze passate: scorrerle tutte per arrivare a domani
 * funzionerebbe, ma renderebbe `MAX_OCCURRENCES` un limite sul numero di giri
 * invece che sul numero di righe prodotte, cioè un limite sulla cosa sbagliata.
 *
 * La stima aritmetica può sbagliare di uno per via del troncamento di fine
 * mese, quindi viene corretta verificando le date vere.
 */
export function firstIndexOnOrAfter(
  start: Date,
  unit: RecurrenceUnit,
  interval: number,
  target: Date,
): number {
  const anchor = startOfUtcDay(start);
  const wanted = startOfUtcDay(target);
  if (wanted <= anchor) return 0;
  if (unit === 'ONE_OFF') return 1; // nessuna: l'unica occorrenza è già passata

  assertPositiveInterval(interval);

  let estimate: number;
  if (unit === 'DAY' || unit === 'WEEK') {
    const step = unit === 'DAY' ? interval : interval * 7;
    estimate = Math.ceil(differenceInDays(anchor, wanted) / step);
  } else {
    const step = unit === 'MONTH' ? interval : interval * 12;
    const months =
      (wanted.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      (wanted.getUTCMonth() - anchor.getUTCMonth());
    estimate = Math.ceil(months / step);
  }

  let index = Math.max(0, estimate);
  while (occurrenceDate(anchor, unit, interval, index) < wanted) index += 1;
  while (index > 0 && occurrenceDate(anchor, unit, interval, index - 1) >= wanted) index -= 1;
  return index;
}

export interface ScheduleInput {
  /** Ancora della serie: l'occorrenza zero cade esattamente qui. */
  start: Date;
  unit: RecurrenceUnit;
  interval: number;
  /** Fine del contratto: oltre non si genera. */
  end?: Date | null;
  /** Ultimo giorno da materializzare, incluso. */
  until: Date;
  /** Primo giorno da restituire, incluso. Le occorrenze prima esistono, ma non servono. */
  from?: Date | null;
}

/**
 * Le date della serie che cadono nella finestra richiesta.
 *
 * `from` non sposta l'ancora: l'occorrenza resta la numero *n* della serie
 * originale, e chiedere solo le future non cambia le date di quelle passate.
 * È la proprietà che permette di rigenerare il futuro senza toccare lo storico.
 */
export function generateSchedule(input: ScheduleInput): Date[] {
  const anchor = startOfUtcDay(input.start);
  const until = startOfUtcDay(input.until);
  const end = input.end == null ? null : startOfUtcDay(input.end);
  const from = input.from == null ? anchor : startOfUtcDay(input.from);

  if (end !== null && end < anchor) {
    throw new RecurrenceError('La data di fine precede quella di inizio');
  }

  // L'orizzonte vero è il più vicino fra la fine del contratto e la fine della
  // finestra: un contratto che scade a giugno non ha occorrenze a luglio
  // nemmeno se l'orizzonte arriva a dicembre.
  const last = end !== null && end < until ? end : until;
  if (last < anchor) return [];

  const dates: Date[] = [];
  let index = firstIndexOnOrAfter(anchor, input.unit, input.interval, from);

  for (;;) {
    if (input.unit === 'ONE_OFF' && index > 0) break;
    const date = occurrenceDate(anchor, input.unit, input.interval, index);
    if (date > last) break;
    dates.push(date);
    if (dates.length > MAX_OCCURRENCES) {
      throw new RecurrenceError(
        `La ricorrenza produce più di ${String(MAX_OCCURRENCES)} occorrenze nella finestra richiesta`,
      );
    }
    index += 1;
  }

  return dates;
}

/** L'ultimo giorno da materializzare, a partire da oggi. */
export function scheduleHorizon(today: Date, months: number = DEFAULT_HORIZON_MONTHS): Date {
  return addMonths(startOfUtcDay(today), months);
}

/**
 * L'ultimo giorno utile per disdire prima che il contratto si rinnovi.
 *
 * È la scadenza che conta davvero: dopo si paga un altro anno, mentre la data
 * di rinnovo in sé è solo il giorno in cui parte l'addebito. Restituisce `null`
 * quando non c'è preavviso da rispettare, che non è lo stesso di «scade oggi».
 */
export function cancellationDeadline(dueDate: Date, noticeDays: number | null): Date | null {
  if (noticeDays === null) return null;
  if (!Number.isInteger(noticeDays) || noticeDays < 0) {
    throw new RecurrenceError(
      `Il preavviso dev'essere un intero non negativo, ricevuto ${String(noticeDays)}`,
    );
  }
  return addDays(dueDate, -noticeDays);
}

/**
 * Il periodo che un pagamento copre.
 *
 * Serve ad attribuire il costo ai mesi giusti: un dominio pagato a gennaio per
 * tutto l'anno non è un costo di gennaio, è un dodicesimo al mese. Il periodo
 * finisce il giorno prima dell'occorrenza successiva, non lo stesso giorno,
 * altrimenti due periodi consecutivi si sovrapporrebbero di ventiquattro ore e
 * ogni somma per intervallo conterebbe un giorno due volte.
 */
export function occurrencePeriod(
  start: Date,
  unit: RecurrenceUnit,
  interval: number,
  index: number,
): { periodStart: Date; periodEnd: Date | null } {
  const periodStart = occurrenceDate(start, unit, interval, index);
  if (unit === 'ONE_OFF') return { periodStart, periodEnd: null };
  return { periodStart, periodEnd: addDays(occurrenceDate(start, unit, interval, index + 1), -1) };
}
