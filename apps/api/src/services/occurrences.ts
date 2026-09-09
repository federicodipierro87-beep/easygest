import {
  DEFAULT_HORIZON_MONTHS,
  firstIndexOnOrAfter,
  generateSchedule,
  generatesOccurrences,
  occurrencePeriod,
  scheduleHorizon,
  startOfUtcDay,
  todayIn,
} from '@easygest/shared';

import type { Expense, PrismaClient } from '../generated/prisma/client';
import { convertToBase } from './fx';

/**
 * Materializzazione delle occorrenze di una spesa.
 *
 * Il motore delle ricorrenze (`@easygest/shared`) sa dire quali giorni cadono
 * nella finestra; qui si decide cosa scrivere, cosa lasciare stare e cosa
 * togliere. La distinzione è tutta in una riga: **si tocca solo il futuro**.
 *
 * Un'occorrenza passata è un fatto avvenuto. Anche quando è ancora `PLANNED` —
 * cioè scaduta e non pagata — non è un residuo da ripulire ma un debito vero,
 * e cancellarla perché la spesa nel frattempo è cambiata significherebbe far
 * sparire dai conti qualcosa che va comunque pagato.
 */

/**
 * Quanto indietro si materializza: niente.
 *
 * Aggiungere oggi un abbonamento che parte dal 2020 non genera sessanta
 * occorrenze `PLANNED` retroattive. Sarebbero sessanta righe «da pagare» per
 * pagamenti già fatti, e nessuno le andrebbe a sistemare a mano. Lo storico
 * anteriore all'inserimento non si inventa: si importa, e importarlo è un
 * lavoro diverso da questo.
 */

export interface OccurrenceContext {
  /** Valuta dei report, da `Settings`. */
  baseCurrency: string;
  /** Il giorno di riferimento, già nel fuso dell'utente. */
  today: Date;
}

export interface SyncOccurrencesResult {
  created: number;
  updated: number;
  removed: number;
  /** L'ultimo giorno materializzato, utile a chi mostra il calendario. */
  horizon: Date;
}

/**
 * Il contesto letto dalle impostazioni dell'utente.
 *
 * `now` entra come parametro per la stessa ragione per cui ci entra nel motore:
 * un test che dipende dall'orologio si può scrivere una volta e poi fallisce da
 * solo il primo giorno in cui il fuso cambia.
 */
export async function occurrenceContext(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<OccurrenceContext> {
  const settings = await prisma.settings.findUniqueOrThrow({
    where: { userId },
    select: { baseCurrency: true, timezone: true },
  });
  return {
    baseCurrency: settings.baseCurrency,
    today: todayIn(settings.timezone, now),
  };
}

/**
 * Allinea le occorrenze future di una spesa al suo calendario attuale.
 *
 * Idempotente per costruzione: rilanciarla senza che sia cambiato niente non
 * scrive niente. La garanzia contro le doppie non è però qui, è nel vincolo
 * unico `(expenseId, dueDate)` — perché due esecuzioni in parallelo leggerebbero
 * entrambe una tabella vuota e proverebbero entrambe a scrivere.
 *
 * Le tre operazioni, nell'ordine:
 *
 * 1. **Toglie** le `PLANNED` future che il calendario non prevede più. Sono
 *    quelle rimaste da un intervallo o una data d'inizio precedenti; le
 *    `PAID`, `SKIPPED` e `CANCELLED` non si toccano mai, sono storia.
 * 2. **Crea** i giorni previsti che non hanno ancora una riga, con importi e
 *    cambio copiati dalla spesa.
 * 3. **Aggiorna** gli importi delle `PLANNED` future già presenti, altrimenti
 *    cambiare il prezzo di un abbonamento non cambierebbe le rate che deve
 *    ancora produrre.
 *
 * Il passo 3 aggiorna solo i soldi, non le date: se una data è sopravvissuta
 * al ricalcolo vuol dire che la serie non si è mossa sotto di lei. L'unica
 * eccezione è il periodo coperto, che può cambiare senza che cambi la data —
 * passando da mensile a bimestrale il primo marzo resta, ma copre due mesi
 * invece di uno — e per quello serve una scrittura riga per riga.
 */
export async function syncOccurrences(
  prisma: PrismaClient,
  expense: Expense,
  context: OccurrenceContext,
  options: { horizonMonths?: number } = {},
): Promise<SyncOccurrencesResult> {
  const today = startOfUtcDay(context.today);
  const horizon = scheduleHorizon(today, options.horizonMonths ?? DEFAULT_HORIZON_MONTHS);
  const start = startOfUtcDay(expense.startDate);
  const { recurrenceUnit: unit, recurrenceInterval: interval } = expense;

  // Una spesa in pausa, disdetta o finita smette di produrre: la lista resta
  // vuota, e il passo 1 si porta via il futuro già scritto.
  const wanted = generatesOccurrences(expense.status)
    ? generateSchedule({
        start,
        unit,
        interval,
        end: expense.endDate,
        until: horizon,
        from: today,
      })
    : [];

  // L'indice serve al periodo coperto e va contato dall'ancora, non dalla
  // finestra: l'occorrenza di marzo è la numero 14 della serie anche se è la
  // prima che stiamo guardando.
  const firstIndex = wanted.length === 0 ? 0 : firstIndexOnOrAfter(start, unit, interval, today);

  const existing = await prisma.expenseOccurrence.findMany({
    where: { expenseId: expense.id, dueDate: { gte: today } },
    select: { id: true, dueDate: true, status: true, periodStart: true, periodEnd: true },
  });

  const wantedTimes = new Set(wanted.map((date) => date.getTime()));
  const existingTimes = new Set(existing.map((row) => row.dueDate.getTime()));

  const stale = existing.filter(
    (row) => row.status === 'PLANNED' && !wantedTimes.has(row.dueDate.getTime()),
  );

  const missing = wanted
    .map((date, offset) => ({ date, index: firstIndex + offset }))
    .filter(({ date }) => !existingTimes.has(date.getTime()));

  const refresh = existing.filter(
    (row) => row.status === 'PLANNED' && wantedTimes.has(row.dueDate.getTime()),
  );

  /**
   * Il cambio è uno solo per tutta la sincronizzazione, quello di oggi.
   *
   * Non esiste il cambio del 15 marzo dell'anno prossimo, e chiederlo con la
   * data di scadenza darebbe il tasso più recente non successivo — cioè quello
   * di oggi, ma dichiarato vecchio di un anno e quindi rifiutato. Per
   * un'occorrenza futura il cambio è una stima, e si rinfresca da sé perché ogni
   * sincronizzazione riscrive gli importi delle `PLANNED` future. Quello vero si
   * congela alla maturazione, che è il momento in cui l'occorrenza smette di
   * essere una previsione.
   */
  const money =
    missing.length === 0 && refresh.length === 0
      ? null
      : await convertToBase(
          prisma,
          expense.grossCents,
          expense.currency,
          context.baseCurrency,
          today,
        );

  const amounts =
    money === null
      ? null
      : {
          netCents: expense.netCents,
          vatRateBp: expense.vatRateBp,
          grossCents: expense.grossCents,
          currency: expense.currency,
          fxRate: money.fxRate,
          baseGrossCents: money.baseCents,
        };

  // Le date sopravvissute il cui periodo non è più quello giusto. Quasi sempre
  // nessuna: succede solo quando cambia l'intervallo senza spostare il giorno.
  const reperiod =
    amounts === null ? [] : periodFixes(existing, wanted, firstIndex, start, unit, interval);

  const [removed, created] = await prisma.$transaction(async (tx) => {
    const deleted =
      stale.length === 0
        ? { count: 0 }
        : await tx.expenseOccurrence.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });

    const inserted =
      amounts === null || missing.length === 0
        ? { count: 0 }
        : await tx.expenseOccurrence.createMany({
            data: missing.map(({ date, index }) => {
              const period = occurrencePeriod(start, unit, interval, index);
              return {
                userId: expense.userId,
                expenseId: expense.id,
                dueDate: date,
                periodStart: period.periodStart,
                periodEnd: period.periodEnd,
                ...amounts,
              };
            }),
            skipDuplicates: true,
          });

    if (amounts !== null && refresh.length > 0) {
      await tx.expenseOccurrence.updateMany({
        where: { id: { in: refresh.map((r) => r.id) } },
        data: amounts,
      });
    }

    for (const fix of reperiod) {
      await tx.expenseOccurrence.update({
        where: { id: fix.id },
        data: { periodStart: fix.periodStart, periodEnd: fix.periodEnd },
      });
    }

    return [deleted.count, inserted.count] as const;
  });

  return { created, updated: refresh.length, removed, horizon };
}

interface PeriodFix {
  id: string;
  periodStart: Date;
  periodEnd: Date | null;
}

function periodFixes(
  existing: {
    id: string;
    dueDate: Date;
    status: string;
    periodStart: Date | null;
    periodEnd: Date | null;
  }[],
  wanted: Date[],
  firstIndex: number,
  start: Date,
  unit: Expense['recurrenceUnit'],
  interval: number,
): PeriodFix[] {
  const indexByTime = new Map(wanted.map((date, offset) => [date.getTime(), firstIndex + offset]));
  const fixes: PeriodFix[] = [];

  for (const row of existing) {
    if (row.status !== 'PLANNED') continue;
    const index = indexByTime.get(row.dueDate.getTime());
    if (index === undefined) continue;

    const period = occurrencePeriod(start, unit, interval, index);
    const sameStart = row.periodStart?.getTime() === period.periodStart.getTime();
    const sameEnd = (row.periodEnd?.getTime() ?? null) === (period.periodEnd?.getTime() ?? null);
    if (sameStart && sameEnd) continue;

    fixes.push({ id: row.id, periodStart: period.periodStart, periodEnd: period.periodEnd });
  }

  return fixes;
}
