import { z } from 'zod';

import type { OccurrenceStatus } from './expenses';
import type { Cents } from './money';
import { countsTowardReport } from './reports';

/**
 * Le righe di una previsione d'anno, e i numeri che se ne ricavano.
 *
 * **Non si riusa `foldReport`**, e vale la pena dire perché invece di
 * scoprirlo fra sei mesi. `ReportSummary` non ha una matrice per spesa, e il
 * suo `byMonth` è `{ month, totalCents, count }`: le leve del simulatore hanno
 * bisogno di sapere quale spesa cade in quale mese — per poterla togliere — e
 * di distinguere ciò che è già successo da ciò che è previsto, perché una
 * percentuale sui costi futuri non deve toccare il passato. Allargare
 * `ReportSummary` per servire due pagine significherebbe avere un tipo che non
 * descrive bene nessuna delle due.
 *
 * Quello che invece si riusa è la regola su cosa conta: `countsTowardReport`,
 * importata e non ricopiata. Una scadenza saltata non è costata niente né nel
 * report né nelle previsioni, e due copie della stessa condizione divergono
 * alla prima modifica di una sola delle due.
 *
 * L'attribuzione al mese resta per `dueDate`, sempre come nel report: la stessa
 * spesa non può cadere in due mesi diversi in due pagine diverse. Non è la
 * competenza, e il registro lo dichiara.
 */

/**
 * L'anno che si può chiedere.
 *
 * Gli estremi non difendono da un calcolo pesante — le righe sintetiche di un
 * anno sono al massimo trecentosessantacinque per spesa, qualunque sia l'anno —
 * ma da una domanda che non è una domanda: `?anno=0` o `?anno=99999` sono un
 * refuso nella barra degli indirizzi, e rispondere con dodici mesi vuoti li
 * farebbe sembrare una risposta.
 */
export const FORECAST_MIN_YEAR = 2000;
export const FORECAST_MAX_YEAR = 2100;

/**
 * `z.coerce` perché arriva da una query string, dove tutto è testo.
 *
 * `.int()` dopo la coercizione è quello che rifiuta `2027,5` e `duemila`:
 * `Number('duemila')` è `NaN`, che non è intero.
 */
export const forecastQuerySchema = z.object({
  year: z.coerce
    .number()
    .int('L’anno va scritto in cifre')
    .min(FORECAST_MIN_YEAR, `Il primo anno previsto è il ${String(FORECAST_MIN_YEAR)}`)
    .max(FORECAST_MAX_YEAR, `L’ultimo anno previsto è il ${String(FORECAST_MAX_YEAR)}`),
});

export type ForecastQuery = z.infer<typeof forecastQuerySchema>;

/**
 * Una riga di previsione: o un'occorrenza vera, o una data che ci sarà.
 *
 * `occurrenceId` e `status` sono **nullable e non finti**. Una riga che non
 * esiste nel database non ha un id, e inventargliene uno la renderebbe
 * indistinguibile da una reale il giorno in cui qualcuno ci clicca sopra per
 * marcarla pagata — ottenendo un 404, o peggio, la spesa sbagliata.
 *
 * `source` è ridondante rispetto a `occurrenceId` **di proposito**. È il campo
 * che l'interfaccia legge per colorare una riga o intestare una colonna, e
 * leggere «è nullo l'id» per dire «è una previsione» è un'inferenza che si
 * dimentica: la prima volta che qualcuno rende `occurrenceId` non nullo, le
 * colonne si mescolano in silenzio.
 *
 * `vendorName` e non `supplierName`: il resto del programma — `ReportRow`,
 * `vendors.ts`, le rotte — chiama `vendor` il fornitore, e un terzo nome per la
 * stessa cosa costa una ricerca a ogni lettura.
 *
 * `baseGrossCents` arriva **già convertito** in valuta base, come in
 * `ReportRow`: la conversione usa `Prisma.Decimal` e quindi vive nell'API. Qui
 * si somma e basta.
 */
export interface ForecastRow {
  /** `null` su una riga sintetica: non esiste in tabella, non ha un id. */
  occurrenceId: string | null;
  expenseId: string;
  expenseName: string;
  vendorName: string | null;
  categoryName: string | null;
  dueDate: string;
  baseGrossCents: Cents;
  source: 'reale' | 'previsione';
  /** `null` sulle sintetiche: una riga che non c'è non ha uno stato. */
  status: OccurrenceStatus | null;
}

/**
 * Una spesa il cui futuro non si è potuto convertire.
 *
 * Non è un errore: le righe passate hanno il loro controvalore congelato e
 * restano al loro posto, è solo il futuro a non avere un cambio con cui essere
 * pesato. La risposta resta 200 e la spesa finisce qui, perché un totale che
 * manca si vede mentre un totale sbagliato per difetto no.
 */
export interface ForecastUnconverted {
  expenseId: string;
  expenseName: string;
  currency: string;
}

/**
 * Quello che l'API restituisce: **le righe**, non gli aggregati.
 *
 * Le leve del simulatore lavorano sulla singola spesa — togline una, ritocca
 * del 10 % i costi futuri — e un'API che desse già i totali costringerebbe a un
 * giro di rete a ogni spunta. La piega la fa il browser, con `foldForecast`, ed
 * è la stessa funzione che userebbe il server.
 *
 * `today` viaggia nella risposta e non si ricalcola nel browser. È il giorno su
 * cui il server ha tagliato fra reale e previsto, ed è lo stesso su cui il
 * simulatore deve decidere quali righe la percentuale può toccare: due «oggi»
 * diversi — uno nel fuso dell'utente, uno in quello del browser — sposterebbero
 * il confine di un giorno, e quel giorno è un mese intero se la spesa è
 * mensile.
 */
export interface Forecast {
  year: number;
  baseCurrency: string;
  /** Il giorno del taglio, nel fuso dell'utente. */
  today: string;
  rows: ForecastRow[];
  unconverted: ForecastUnconverted[];
}

/**
 * Un mese, con le due metà separate.
 *
 * Non un totale solo: il mese in corso contiene quasi sempre entrambe le cose —
 * le scadenze già maturate e quelle che mancano — e sommarle nasconderebbe
 * proprio il confine su cui il simulatore lavora.
 */
export interface ForecastMonth {
  /** `YYYY-MM`. */
  month: string;
  realCents: Cents;
  forecastCents: Cents;
  count: number;
}

export interface ForecastExpense {
  expenseId: string;
  expenseName: string;
  totalCents: Cents;
  count: number;
}

export interface ForecastSummary {
  year: number;
  totalCents: Cents;
  realCents: Cents;
  forecastCents: Cents;
  count: number;
  /** Dodici, sempre tutti. */
  byMonth: ForecastMonth[];
  /** Per importo decrescente: è l'ordine in cui si sceglie cosa tagliare. */
  byExpense: ForecastExpense[];
}

/**
 * Se la riga pesa sul conto.
 *
 * Le sintetiche pesano sempre — sono previsioni, non hanno ancora uno stato da
 * cui essere escluse — e le reali seguono la regola del report.
 */
export function countsTowardForecast(status: OccurrenceStatus | null): boolean {
  return status === null || countsTowardReport(status);
}

/** I dodici mesi di un anno, in ordine. */
function monthsOf(year: number): string[] {
  const prefix = String(year).padStart(4, '0');
  return Array.from(
    { length: 12 },
    (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`,
  );
}

/**
 * Ordine per totale decrescente, pareggi risolti per nome.
 *
 * Il secondo criterio è la stessa difesa di `byTotalThenLabel` nel report:
 * senza, due chiamate identiche possono restituire due ordini diversi e
 * l'elenco delle spese da escludere sembrerebbe rimescolarsi da solo.
 */
function byTotalThenName(a: ForecastExpense, b: ForecastExpense): number {
  if (a.totalCents !== b.totalCents) return b.totalCents - a.totalCents;
  if (a.expenseName === b.expenseName) return 0;
  return a.expenseName < b.expenseName ? -1 : 1;
}

/**
 * Le righe di un anno ridotte ai numeri che si guardano.
 *
 * I dodici mesi ci sono **sempre tutti**, anche vuoti: un elenco con i buchi
 * mente, perché un mese che manca si legge come un mese che non è ancora stato
 * calcolato invece che come un mese senza spese.
 *
 * Una riga fuori dall'anno chiesto non inventa un tredicesimo mese — entra nei
 * totali e nella matrice per spesa, ma non trova un secchio dove cadere. Non
 * dovrebbe mai succedere, visto che le righe le sceglie chi chiama; se succede,
 * è meglio un mese mancante che un mese in più con un'etichetta impossibile.
 */
export function foldForecast(
  rows: readonly ForecastRow[],
  options: { year: number },
): ForecastSummary {
  const months = new Map<string, ForecastMonth>();
  for (const month of monthsOf(options.year)) {
    months.set(month, { month, realCents: 0, forecastCents: 0, count: 0 });
  }

  const expenses = new Map<string, ForecastExpense>();
  let realCents = 0;
  let forecastCents = 0;
  let count = 0;

  for (const row of rows) {
    if (!countsTowardForecast(row.status)) continue;

    const isReal = row.source === 'reale';
    if (isReal) realCents += row.baseGrossCents;
    else forecastCents += row.baseGrossCents;
    count += 1;

    const expense = expenses.get(row.expenseId) ?? {
      expenseId: row.expenseId,
      expenseName: row.expenseName,
      totalCents: 0,
      count: 0,
    };
    expense.totalCents += row.baseGrossCents;
    expense.count += 1;
    expenses.set(row.expenseId, expense);

    const bucket = months.get(row.dueDate.slice(0, 7));
    if (bucket !== undefined) {
      if (isReal) bucket.realCents += row.baseGrossCents;
      else bucket.forecastCents += row.baseGrossCents;
      bucket.count += 1;
    }
  }

  return {
    year: options.year,
    totalCents: realCents + forecastCents,
    realCents,
    forecastCents,
    count,
    byMonth: [...months.values()],
    byExpense: [...expenses.values()].sort(byTotalThenName),
  };
}
