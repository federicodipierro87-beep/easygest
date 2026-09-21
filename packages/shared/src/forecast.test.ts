import { describe, expect, it } from 'vitest';

import { type ForecastRow, foldForecast } from './forecast';

/**
 * Le righe di una previsione, piegate.
 *
 * Tre cose da provare, e la prima è quella che l'interfaccia legge: reale e
 * previsto restano separati in ogni totale. Le altre due sono la griglia dei
 * dodici mesi, che non deve avere buchi, e l'ordine delle spese, che non deve
 * cambiare da una chiamata all'altra.
 */

function row(partial: Partial<ForecastRow> & Pick<ForecastRow, 'dueDate'>): ForecastRow {
  return {
    occurrenceId: 'occ-1',
    expenseId: 'exp-1',
    expenseName: 'Affitto',
    vendorName: null,
    categoryName: null,
    baseGrossCents: 100_000,
    source: 'reale',
    status: 'PLANNED',
    ...partial,
  };
}

/** Le tre cose che fanno di una riga una previsione, sempre insieme. */
const SINTETICA: Partial<ForecastRow> = { occurrenceId: null, source: 'previsione', status: null };

describe('foldForecast', () => {
  it('tiene il reale e il previsto in due totali separati', () => {
    // È il motivo per cui questo modulo esiste invece di riusare `foldReport`:
    // la percentuale globale del simulatore tocca solo il secondo dei due.
    const summary = foldForecast(
      [
        row({ dueDate: '2027-01-05', baseGrossCents: 30_000, status: 'PAID' }),
        row({ dueDate: '2027-08-05', baseGrossCents: 50_000, ...SINTETICA }),
      ],
      { year: 2027 },
    );

    expect(summary.realCents).toBe(30_000);
    expect(summary.forecastCents).toBe(50_000);
    expect(summary.totalCents).toBe(80_000);
    expect(summary.count).toBe(2);
  });

  it('separa le due metà anche dentro il mese in cui cade oggi', () => {
    // Il mese in corso contiene quasi sempre entrambe le cose, e un totale
    // solo nasconderebbe proprio il confine su cui il simulatore lavora.
    const summary = foldForecast(
      [
        row({ dueDate: '2027-06-01', baseGrossCents: 10_000, status: 'PAID' }),
        row({ dueDate: '2027-06-28', baseGrossCents: 4_000, ...SINTETICA }),
      ],
      { year: 2027 },
    );

    const giugno = summary.byMonth.find((month) => month.month === '2027-06');
    expect(giugno).toEqual({
      month: '2027-06',
      realCents: 10_000,
      forecastCents: 4_000,
      count: 2,
    });
  });

  it('restituisce dodici mesi anche su un anno senza una riga', () => {
    // Un elenco con i buchi mente: un mese che manca si legge come un mese non
    // ancora calcolato, non come un mese senza spese.
    const summary = foldForecast([], { year: 2027 });

    expect(summary.byMonth).toHaveLength(12);
    expect(summary.byMonth[0]?.month).toBe('2027-01');
    expect(summary.byMonth[11]?.month).toBe('2027-12');
    expect(summary.byMonth.every((month) => month.count === 0)).toBe(true);
    expect(summary.totalCents).toBe(0);
  });

  it('somma per spesa e ordina dalla più cara', () => {
    // È l'ordine in cui si sceglie cosa togliere: la prima riga dell'elenco
    // deve essere quella che sposta di più il netto.
    const summary = foldForecast(
      [
        row({
          dueDate: '2027-01-05',
          expenseId: 'a',
          expenseName: 'Hosting',
          baseGrossCents: 5000,
        }),
        row({
          dueDate: '2027-02-05',
          expenseId: 'a',
          expenseName: 'Hosting',
          baseGrossCents: 5000,
        }),
        row({
          dueDate: '2027-01-10',
          expenseId: 'b',
          expenseName: 'Affitto',
          baseGrossCents: 80_000,
        }),
      ],
      { year: 2027 },
    );

    expect(summary.byExpense).toEqual([
      { expenseId: 'b', expenseName: 'Affitto', totalCents: 80_000, count: 1 },
      { expenseId: 'a', expenseName: 'Hosting', totalCents: 10_000, count: 2 },
    ]);
  });

  it('risolve i pareggi per nome, invece di lasciarli all’ordine di arrivo', () => {
    // Senza il secondo criterio l'elenco sembrerebbe rimescolarsi da solo a
    // ogni ricaricamento, su due spese che costano uguale.
    const rows = [
      row({ dueDate: '2027-01-05', expenseId: 'z', expenseName: 'Zoom', baseGrossCents: 1000 }),
      row({ dueDate: '2027-01-06', expenseId: 'a', expenseName: 'Adobe', baseGrossCents: 1000 }),
    ];

    expect(foldForecast(rows, { year: 2027 }).byExpense.map((e) => e.expenseName)).toEqual([
      'Adobe',
      'Zoom',
    ]);
    expect(foldForecast([...rows].reverse(), { year: 2027 }).byExpense.map((e) => e.expenseName)) //
      .toEqual(['Adobe', 'Zoom']);
  });

  it('non conta le saltate e le annullate, come il report', () => {
    // La regola è importata da `reports.ts` e non ricopiata: una scadenza
    // saltata non è costata niente né lì né qui.
    const summary = foldForecast(
      [
        row({ dueDate: '2027-01-05', baseGrossCents: 30_000, status: 'SKIPPED' }),
        row({ dueDate: '2027-02-05', baseGrossCents: 30_000, status: 'CANCELLED' }),
        row({ dueDate: '2027-03-05', baseGrossCents: 30_000, status: 'PAID' }),
      ],
      { year: 2027 },
    );

    expect(summary.count).toBe(1);
    expect(summary.totalCents).toBe(30_000);
    expect(summary.byExpense).toHaveLength(1);
  });

  it('conta le sintetiche, che uno stato da cui essere escluse non ce l’hanno', () => {
    const summary = foldForecast([row({ dueDate: '2027-09-05', ...SINTETICA })], {
      year: 2027,
    });

    expect(summary.count).toBe(1);
    expect(summary.forecastCents).toBe(100_000);
  });

  it('non inventa un tredicesimo mese per una riga fuori anno', () => {
    // Non dovrebbe succedere — le righe le sceglie chi chiama — ma un mese in
    // più con un'etichetta impossibile sarebbe peggio di un mese mancante.
    const summary = foldForecast([row({ dueDate: '2028-01-05', baseGrossCents: 7000 })], {
      year: 2027,
    });

    expect(summary.byMonth).toHaveLength(12);
    expect(summary.totalCents).toBe(7000);
  });
});
