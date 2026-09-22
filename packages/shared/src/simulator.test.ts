import { describe, expect, it } from 'vitest';

import type { ForecastRow } from './forecast';
import type { Settings } from './settings';
import {
  HYPOTHETICAL_EXPENSE_ID,
  type Levers,
  type SimulationContext,
  neutralLevers,
  simulate,
} from './simulator';

/**
 * Il simulatore, con «oggi» inchiodato al 15 marzo 2027.
 *
 * La prima prova è quella che conta, e non è una formalità: **le leve sui costi
 * non muovono il dovuto**. È il fatto di dominio del forfettario scritto come
 * prova, e il suo unico compito è fermare la mano di chi un giorno «correggerà»
 * il conto facendo dedurre le spese — una correzione che non romperebbe niente,
 * non accenderebbe nessun errore, e produrrebbe un numero credibile e falso su
 * cui qualcuno accantona dei soldi.
 *
 * I numeri del conto sono gli stessi di `taxes.test.ts`: fatturato 50.000 €,
 * coefficiente 67 %, INPS 26,07 %, sostitutiva 5 % → 9.971,78 € di dovuto.
 * Ripeterli qui serve a vedere il netto, che è la cifra che la pagina mostra
 * grande.
 */

const SETTINGS: Settings = {
  taxRegime: 'FORFETTARIO',
  substituteTaxRateBp: 500,
  profitabilityCoefficientBp: 6700,
  inpsRateBp: 2607,
  defaultVatRateBp: 2200,
  baseCurrency: 'EUR',
  timezone: 'Europe/Rome',
  reminderDaysBefore: [7],
  cancellationReminderDaysBefore: [30],
  digestEnabled: true,
  digestDayOfWeek: 1,
  updatedAt: '2027-03-15T08:00:00.000Z',
};

const context: SimulationContext = { settings: SETTINGS, today: '2027-03-15', year: 2027 };

/** Il dovuto su 50.000 €, dalla tabella del conto. */
const REVENUE = 5_000_000;
const TOTAL_DUE = 997_178;

function row(partial: Partial<ForecastRow> & Pick<ForecastRow, 'dueDate'>): ForecastRow {
  return {
    occurrenceId: 'occ-1',
    expenseId: 'hosting',
    expenseName: 'Hosting',
    vendorName: null,
    categoryName: null,
    baseGrossCents: 10_000,
    source: 'reale',
    status: 'PLANNED',
    ...partial,
  };
}

/** Le tre cose che fanno di una riga una previsione, sempre insieme. */
const SINTETICA = { occurrenceId: null, source: 'previsione', status: null } as const;

/** Cento euro già pagati a febbraio, duecento previsti ad aprile. */
const ROWS: ForecastRow[] = [
  row({ dueDate: '2027-02-10', status: 'PAID' }),
  row({ dueDate: '2027-04-10', baseGrossCents: 20_000, ...SINTETICA }),
];

function levers(overrides: Partial<Levers> = {}): Levers {
  return { ...neutralLevers(), revenueCents: REVENUE, ...overrides };
}

describe('il conto', () => {
  it('le leve sui costi non muovono l’imposta né i contributi', () => {
    // La prova che vale per tutte. Nel forfettario il coefficiente di
    // redditività *è* la deduzione: i costi reali non entrano nel conto
    // fiscale, e qui si tirano tutte e tre le leve insieme per dirlo.
    const fermo = simulate(ROWS, levers(), context);
    const tirato = simulate(
      ROWS,
      levers({
        excludedExpenseIds: ['hosting'],
        costAdjustmentBp: 20_000,
        extraMonthlyCents: 50_000,
      }),
      context,
    );

    expect(tirato.taxes).toEqual(fermo.taxes);
    expect(tirato.taxes.totalDueCents).toBe(TOTAL_DUE);
    // Il netto invece si muove: è tutto il senso della pagina.
    expect(tirato.netCents).not.toBe(fermo.netCents);
  });

  it('il netto è il fatturato meno il dovuto meno i costi', () => {
    const result = simulate(ROWS, levers(), context);

    expect(result.summary.totalCents).toBe(30_000);
    expect(result.netCents).toBe(REVENUE - TOTAL_DUE - 30_000);
  });

  it('le aliquote della leva vincono su quelle salvate', () => {
    // È l'altra metà del simulatore: provare un coefficiente diverso senza
    // salvarlo in `/impostazioni/fisco`.
    const result = simulate(ROWS, levers({ rates: { profitabilityCoefficientBp: 7800 } }), context);

    expect(result.taxes.taxableCents).toBe(3_900_000);
    expect(result.taxes.totalDueCents).not.toBe(TOTAL_DUE);
  });

  it('un’aliquota non passata resta quella delle impostazioni', () => {
    const result = simulate(ROWS, levers({ rates: { inpsRateBp: 0 } }), context);

    expect(result.taxes.inpsCents).toBe(0);
    // Il coefficiente non è stato toccato e vale ancora il 67 %.
    expect(result.taxes.taxableCents).toBe(3_350_000);
  });
});

describe('le leve sui costi', () => {
  it('la percentuale tocca solo le righe da oggi in poi', () => {
    // Ritoccare un costo di febbraio non è una simulazione: è uno storico
    // falsificato, ed è il numero che poi non torna col report.
    const result = simulate(ROWS, levers({ costAdjustmentBp: 11_000 }), context);

    expect(result.summary.realCents).toBe(10_000);
    expect(result.summary.forecastCents).toBe(22_000);
  });

  it('spezza i costi sul confine di oggi, e la leva muove solo il futuro', () => {
    // La divisione che la pagina mostra: muovendo il cursore si vede cambiare
    // una riga sola. Se un giorno la percentuale tornasse a toccare tutto,
    // `settledCents` se ne accorgerebbe prima di chiunque guardi lo schermo.
    const fermo = simulate(ROWS, levers(), context);
    expect(fermo.settledCents).toBe(10_000);
    expect(fermo.upcomingCents).toBe(20_000);

    const tirato = simulate(ROWS, levers({ costAdjustmentBp: 11_000 }), context);
    expect(tirato.settledCents).toBe(10_000);
    expect(tirato.upcomingCents).toBe(22_000);
  });

  it('le due parti dei costi sommano sempre al totale', () => {
    // Sommano a `summary.totalCents` anche con l'ipotetica in mezzo, che nasce
    // da oggi in poi e deve quindi ricadere tutta nella parte futura.
    const result = simulate(ROWS, levers({ extraMonthlyCents: 5_000 }), context);

    expect(result.settledCents + result.upcomingCents).toBe(result.summary.totalCents);
    expect(result.settledCents).toBe(10_000);
  });

  it('escludere una spesa la toglie dai costi, non dalle imposte', () => {
    const result = simulate(ROWS, levers({ excludedExpenseIds: ['hosting'] }), context);

    expect(result.rows).toHaveLength(0);
    expect(result.summary.totalCents).toBe(0);
    expect(result.netCents).toBe(REVENUE - TOTAL_DUE);
  });

  it('la spesa ipotetica parte da oggi e non da gennaio', () => {
    const result = simulate([], levers({ extraMonthlyCents: 10_000 }), context);
    const ipotetiche = result.rows.filter((r) => r.expenseId === HYPOTHETICAL_EXPENSE_ID);

    // Dal 15 marzo al 15 dicembre: dieci mensilità, non dodici.
    expect(ipotetiche).toHaveLength(10);
    expect(ipotetiche[0]?.dueDate).toBe('2027-03-15');
    expect(ipotetiche.at(-1)?.dueDate).toBe('2027-12-15');
    expect(ipotetiche.every((r) => r.source === 'previsione')).toBe(true);
    expect(ipotetiche.every((r) => r.occurrenceId === null)).toBe(true);
  });

  it('su un anno tutto futuro l’ipotetica parte dal primo gennaio', () => {
    const result = simulate([], levers({ extraMonthlyCents: 10_000 }), {
      ...context,
      year: 2028,
    });

    expect(result.rows).toHaveLength(12);
    expect(result.rows[0]?.dueDate).toBe('2028-01-01');
    expect(result.summary.totalCents).toBe(120_000);
  });

  it('su un anno già chiuso non si immagina niente', () => {
    const result = simulate([], levers({ extraMonthlyCents: 10_000 }), { ...context, year: 2026 });

    expect(result.rows).toHaveLength(0);
  });

  it('la percentuale non moltiplica la spesa ipotetica', () => {
    // Due leve separate: se il 200 % toccasse anche l'ipotetica, il risultato
    // di ognuna dipenderebbe da dov'è l'altra.
    const result = simulate(
      [],
      levers({ extraMonthlyCents: 10_000, costAdjustmentBp: 20_000 }),
      context,
    );

    expect(result.summary.totalCents).toBe(100_000);
  });

  it('rimette in ordine di scadenza invece di accodare l’ipotetica', () => {
    const result = simulate(ROWS, levers({ extraMonthlyCents: 5_000 }), context);
    const dates = result.rows.map((r) => r.dueDate);

    expect(dates).toEqual([...dates].sort());
  });

  it('rifiuta un «oggi» che non è una data', () => {
    // Il confronto fra stringhe non fallirebbe: direbbe che tutto è passato, e
    // la percentuale smetterebbe di avere effetto in silenzio.
    expect(() => simulate(ROWS, levers(), { ...context, today: 'oggi' })).toThrow();
  });
});
