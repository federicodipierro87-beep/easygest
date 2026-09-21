import {
  type ForecastRow,
  type ForecastUnconverted,
  formatIsoDate,
  generateSchedule,
  startOfUtcDay,
  utcDay,
} from '@easygest/shared';

import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { applyRate, findRate } from './fx';

/**
 * Le righe di un anno: quelle che ci sono, più quelle che ci saranno.
 *
 * `syncOccurrences` materializza tredici mesi avanti e non di più, che è la
 * scelta giusta per una tabella — scrivere ventiquattro mesi di righe `PLANNED`
 * che nessuno guarderà è lavoro sprecato, e sarebbero da riscrivere al primo
 * ritocco del prezzo. Ma una previsione d'anno chiesta a marzo arriva fino al 31
 * dicembre dell'anno prossimo, cioè nove mesi oltre l'orizzonte. Quei nove mesi
 * si calcolano al volo e **non si persistono**: sono una risposta a una domanda,
 * non un fatto da registrare.
 *
 * ## La regola ibrida — si taglia su *oggi*, non su «c'è una riga?»
 *
 * È la parte che si può sbagliare in silenzio, e vale scritta in due righe:
 *
 * ```
 * dueDate <  oggi  →  solo occorrenze reali. Mai sintetizzare.
 * dueDate >= oggi  →  la reale vince; si sintetizzano solo i buchi.
 * ```
 *
 * La regola ingenua — «ogni data generata senza occorrenza reale diventa una
 * previsione» — **inventerebbe lo storico**, che è esattamente ciò che
 * `services/occurrences.ts` si rifiuta di fare: un abbonamento registrato a
 * settembre con `startDate` a gennaio si vedrebbe apparire otto righe di un
 * passato in cui quella spesa non c'era. E produrrebbe doppioni: se l'ancora è
 * stata spostata dopo che un mese era `PAID`, la vecchia riga sopravvive — il
 * ricalcolo rimuove solo le `PLANNED` con `dueDate >= oggi` — e accanto
 * comparirebbe la sintetica alla data nuova, la stessa spesa contata due volte
 * nello stesso mese.
 *
 * ## Il cambio si chiede a *oggi*
 *
 * Chiedere il tasso alla `dueDate` di una riga futura garantisce un rifiuto:
 * `findRate` scarta un tasso più vecchio di dieci giorni rispetto alla data
 * richiesta, e rispetto a dicembre il tasso di oggi è vecchio di trecento
 * giorni. Quindi **un `findRate` per valuta distinta, alla data di oggi**, e
 * `applyRate` puro su ogni riga — non `convertToBase`, che farebbe un viaggio
 * al database per riga e **lancia** invece di dire cosa non sa fare.
 */

export interface ForecastContext {
  /** Valuta dei report, da `Settings`. */
  baseCurrency: string;
  /** Il giorno di riferimento, già nel fuso dell'utente. */
  today: Date;
}

export interface CollectedForecast {
  rows: ForecastRow[];
  unconverted: ForecastUnconverted[];
}

const REAL_SELECT = {
  id: true,
  expenseId: true,
  dueDate: true,
  baseGrossCents: true,
  status: true,
  expense: {
    select: {
      name: true,
      category: { select: { name: true } },
      vendor: { select: { name: true } },
    },
  },
} satisfies Prisma.ExpenseOccurrenceSelect;

/**
 * Solo le `ACTIVE` producono futuro.
 *
 * È la stessa condizione di `generatesOccurrences`, applicata però nel `where`
 * invece che riga per riga: una spesa in pausa, disdetta o finita non va nemmeno
 * caricata. Il suo passato resta — le occorrenze già maturate sono nella query
 * qui sopra — e il suo futuro è zero, che è la lettura onesta di «sospesa».
 */
const ACTIVE_SELECT = {
  id: true,
  name: true,
  currency: true,
  grossCents: true,
  startDate: true,
  endDate: true,
  recurrenceUnit: true,
  recurrenceInterval: true,
  category: { select: { name: true } },
  vendor: { select: { name: true } },
} satisfies Prisma.ExpenseSelect;

/** La chiave con cui una data reale copre una data generata. */
function slot(expenseId: string, time: number): string {
  return `${expenseId}@${String(time)}`;
}

/**
 * I tassi delle valute che servono, uno per valuta e tutti a oggi.
 *
 * `null` in tabella è una valuta che non si sa convertire, e chi chiama la
 * trasforma in una voce di `unconverted` invece che in righe da zero euro.
 */
async function ratesAt(
  prisma: PrismaClient,
  currencies: Set<string>,
  baseCurrency: string,
  on: Date,
): Promise<Map<string, string | null>> {
  const rates = new Map<string, string | null>();
  for (const currency of currencies) {
    const resolved = await findRate(prisma, baseCurrency, currency, on);
    rates.set(currency, resolved === null ? null : resolved.rate);
  }
  return rates;
}

/**
 * Ordine per scadenza, pareggi risolti per nome e poi per id.
 *
 * Le sintetiche non hanno un id da usare come ultimo criterio — è il prezzo di
 * non avercelo finto — ma il nome basta a rendere l'ordine stabile fra due
 * chiamate, ed è quello che impedisce alla tabella di sembrare rimescolata a
 * ogni ricaricamento.
 */
function byDueDateThenName(a: ForecastRow, b: ForecastRow): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.expenseName !== b.expenseName) return a.expenseName < b.expenseName ? -1 : 1;
  return (a.occurrenceId ?? '').localeCompare(b.occurrenceId ?? '');
}

export async function collectForecast(
  prisma: PrismaClient,
  userId: string,
  year: number,
  context: ForecastContext,
): Promise<CollectedForecast> {
  const yearStart = utcDay(year, 1, 1);
  const yearEnd = utcDay(year, 12, 31);
  const today = startOfUtcDay(context.today);

  const real = await prisma.expenseOccurrence.findMany({
    where: { userId, dueDate: { gte: yearStart, lte: yearEnd } },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    select: REAL_SELECT,
  });

  const rows: ForecastRow[] = real.map((row) => ({
    occurrenceId: row.id,
    expenseId: row.expenseId,
    expenseName: row.expense.name,
    vendorName: row.expense.vendor?.name ?? null,
    categoryName: row.expense.category?.name ?? null,
    dueDate: formatIsoDate(row.dueDate),
    // Già in valuta base e congelato alla maturazione: non si riconverte mai,
    // o un anno passato cambierebbe da solo tutte le mattine.
    baseGrossCents: row.baseGrossCents,
    source: 'reale',
    status: row.status,
  }));

  /**
   * Da dove comincia il futuro: il più avanti fra oggi e il primo gennaio.
   *
   * Su un anno già chiuso questo cade oltre il 31 dicembre, e non si sintetizza
   * niente: un anno passato è fatto solo di ciò che è successo. Su un anno
   * futuro cade al primo gennaio, e si sintetizza tutto.
   */
  const from = today > yearStart ? today : yearStart;
  if (from > yearEnd) return { rows, unconverted: [] };

  const expenses = await prisma.expense.findMany({
    where: { userId, status: 'ACTIVE' },
    select: ACTIVE_SELECT,
  });

  const taken = new Set(real.map((row) => slot(row.expenseId, row.dueDate.getTime())));

  const pending = expenses
    .map((expense) => ({
      expense,
      dates: generateSchedule({
        start: expense.startDate,
        unit: expense.recurrenceUnit,
        interval: expense.recurrenceInterval,
        end: expense.endDate,
        until: yearEnd,
        from,
      }).filter((date) => !taken.has(slot(expense.id, date.getTime()))),
    }))
    .filter(({ dates }) => dates.length > 0);

  const rates = await ratesAt(
    prisma,
    new Set(pending.map(({ expense }) => expense.currency)),
    context.baseCurrency,
    today,
  );

  const unconverted: ForecastUnconverted[] = [];

  for (const { expense, dates } of pending) {
    const rate = rates.get(expense.currency) ?? null;
    if (rate === null) {
      // Fuori dalle righe e quindi dai totali, ma dichiarata: l'interfaccia
      // nasconde il netto invece di mostrarne uno falso per difetto.
      unconverted.push({
        expenseId: expense.id,
        expenseName: expense.name,
        currency: expense.currency,
      });
      continue;
    }

    const baseGrossCents = applyRate(expense.grossCents, rate);
    for (const date of dates) {
      rows.push({
        occurrenceId: null,
        expenseId: expense.id,
        expenseName: expense.name,
        vendorName: expense.vendor?.name ?? null,
        categoryName: expense.category?.name ?? null,
        dueDate: formatIsoDate(date),
        baseGrossCents,
        source: 'previsione',
        status: null,
      });
    }
  }

  return { rows: rows.sort(byDueDateThenName), unconverted };
}
