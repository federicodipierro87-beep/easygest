import { describe, expect, it } from 'vitest';

import { type ReportRow, foldReport, reportQuerySchema } from './reports';
import { parseIsoDate } from './recurrence';

/**
 * `foldReport` è dove stanno i numeri dei report, ed è puro: nessun database,
 * nessuna rete, nessun fuso. È il posto giusto per congelare le sei regole che
 * altrimenti si verificherebbero a occhio in produzione, cioè troppo tardi e
 * su dati che non si possono ripetere.
 */

const d = (value: string): Date => {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error(`Data di test non valida: ${value}`);
  return parsed;
};

const PERIOD = { from: d('2027-01-01'), to: d('2027-03-31'), baseCurrency: 'EUR' };

let counter = 0;

/** Una riga plausibile, su cui ogni prova cambia una cosa sola. */
function aRow(overrides: Partial<ReportRow> = {}): ReportRow {
  counter += 1;
  return {
    occurrenceId: `occ-${String(counter)}`,
    expenseId: `exp-${String(counter)}`,
    expenseName: 'Hosting',
    dueDate: '2027-01-15',
    periodStart: '2027-01-01',
    periodEnd: '2027-01-31',
    netCents: 10_000,
    vatRateBp: 2200,
    grossCents: 12_200,
    currency: 'EUR',
    fxRate: null,
    baseGrossCents: 12_200,
    status: 'PLANNED',
    paidAt: null,
    confirmedAt: null,
    categoryId: 'cat-1',
    categoryName: 'Infrastruttura',
    vendorId: 'ven-1',
    vendorName: 'Aruba',
    clientId: null,
    clientName: null,
    rebillBaseCents: 0,
    ...overrides,
  };
}

describe('validazione del periodo', () => {
  it('rifiuta una fine che precede l’inizio, indicando il campo', () => {
    const result = reportQuerySchema.safeParse({ from: '2027-03-31', to: '2027-01-01' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('to');
  });

  it('rifiuta un periodo oltre i tre anni', () => {
    // È l'unica difesa contro `from=1970-01-01`: qui non c'è paginazione.
    const result = reportQuerySchema.safeParse({ from: '2020-01-01', to: '2027-01-01' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('to');
  });

  it('un periodo di un giorno solo è legittimo', () => {
    expect(reportQuerySchema.safeParse({ from: '2027-01-01', to: '2027-01-01' }).success).toBe(
      true,
    );
  });
});

describe('totali', () => {
  it('somma la valuta base e non quella scritta sulla fattura', () => {
    // La riga in dollari ha un lordo più alto e un controvalore più basso:
    // sommare `grossCents` darebbe 27 200 invece di 21 200, e sembrerebbe
    // plausibile.
    const summary = foldReport(
      [
        aRow({ grossCents: 12_200, baseGrossCents: 12_200 }),
        aRow({
          currency: 'USD',
          grossCents: 15_000,
          fxRate: '0.6000000000',
          baseGrossCents: 9_000,
        }),
      ],
      PERIOD,
    );

    expect(summary.totalCents).toBe(21_200);
    expect(summary.count).toBe(2);
    expect(summary.foreignCount).toBe(1);
  });

  it('lascia fuori le saltate e le annullate, ma tiene le previste', () => {
    // Una `PLANNED` è un impegno preso: un report che mostra solo il pagato
    // racconta il passato quando la domanda è quanto costa questo periodo.
    const summary = foldReport(
      [
        aRow({ status: 'PLANNED', baseGrossCents: 1_000 }),
        aRow({ status: 'PAID', baseGrossCents: 2_000 }),
        aRow({ status: 'SKIPPED', baseGrossCents: 400_000 }),
        aRow({ status: 'CANCELLED', baseGrossCents: 800_000 }),
      ],
      PERIOD,
    );

    expect(summary.totalCents).toBe(3_000);
    expect(summary.count).toBe(2);
  });

  it('su un periodo senza righe non divide per zero', () => {
    const summary = foldReport([], PERIOD);

    expect(summary.totalCents).toBe(0);
    expect(summary.count).toBe(0);
    expect(summary.byCategory).toEqual([]);
    expect(summary.byMonth.every((month) => month.totalCents === 0)).toBe(true);
  });
});

describe('raggruppamenti', () => {
  it('le righe senza categoria finiscono in un gruppo etichettato, non nel nulla', () => {
    // Nascondere gli scoperti è il modo migliore per non accorgersene: la
    // somma dei gruppi tornerebbe comunque, ma mancherebbe una voce di spesa.
    const summary = foldReport(
      [
        aRow({ categoryId: null, categoryName: null, baseGrossCents: 5_000 }),
        aRow({ categoryId: 'cat-1', categoryName: 'Infrastruttura', baseGrossCents: 5_000 }),
      ],
      PERIOD,
    );

    const orphan = summary.byCategory.find((bucket) => bucket.id === null);
    expect(orphan?.label).toBe('Senza categoria');
    expect(orphan?.totalCents).toBe(5_000);
    expect(summary.byCategory.reduce((sum, bucket) => sum + bucket.totalCents, 0)).toBe(
      summary.totalCents,
    );
  });

  it('le quote non sommano a 10 000, ed è giusto così', () => {
    // Tre gruppi da un terzo danno 3333 tre volte, cioè 9999. È
    // arrotondamento, non un difetto — e va congelato, perché il giorno in cui
    // qualcuno "sistemasse" l'ultimo gruppo per far tornare il conto starebbe
    // scrivendo un numero falso. Per questo la pagina non stampa mai un
    // «totale 100 %».
    const summary = foldReport(
      [
        aRow({ categoryId: 'a', categoryName: 'A', baseGrossCents: 1_000 }),
        aRow({ categoryId: 'b', categoryName: 'B', baseGrossCents: 1_000 }),
        aRow({ categoryId: 'c', categoryName: 'C', baseGrossCents: 1_000 }),
      ],
      PERIOD,
    );

    expect(summary.byCategory.map((bucket) => bucket.shareBp)).toEqual([3333, 3333, 3333]);
    expect(summary.byCategory.reduce((sum, bucket) => sum + bucket.shareBp, 0)).toBe(9_999);
  });

  it('a parità di totale l’ordine è sempre lo stesso', () => {
    // Senza il secondo criterio due chiamate identiche darebbero due ordini, e
    // la pagina sembrerebbe cambiare da sola a ogni ricaricamento.
    const rows = [
      aRow({ vendorId: 'v2', vendorName: 'Zeta', baseGrossCents: 1_000 }),
      aRow({ vendorId: 'v1', vendorName: 'Alfa', baseGrossCents: 1_000 }),
    ];

    expect(foldReport(rows, PERIOD).byVendor.map((bucket) => bucket.label)).toEqual([
      'Alfa',
      'Zeta',
    ]);
    expect(foldReport([...rows].reverse(), PERIOD).byVendor.map((bucket) => bucket.label)).toEqual([
      'Alfa',
      'Zeta',
    ]);
  });

  it('ordina per totale decrescente', () => {
    const summary = foldReport(
      [
        aRow({ vendorId: 'v1', vendorName: 'Alfa', baseGrossCents: 1_000 }),
        aRow({ vendorId: 'v2', vendorName: 'Zeta', baseGrossCents: 9_000 }),
      ],
      PERIOD,
    );

    expect(summary.byVendor.map((bucket) => bucket.label)).toEqual(['Zeta', 'Alfa']);
  });
});

describe('margine teorico', () => {
  it('è il riaddebito meno il costo, per cliente', () => {
    const summary = foldReport(
      [
        aRow({
          clientId: 'cli-1',
          clientName: 'Rossi srl',
          baseGrossCents: 10_000,
          rebillBaseCents: 12_000,
        }),
        aRow({
          clientId: 'cli-1',
          clientName: 'Rossi srl',
          baseGrossCents: 5_000,
          rebillBaseCents: 5_000,
        }),
      ],
      PERIOD,
    );

    const client = summary.byClient.find((bucket) => bucket.id === 'cli-1');
    expect(client?.totalCents).toBe(15_000);
    expect(client?.rebillCents).toBe(17_000);
    expect(client?.theoreticalMarginCents).toBe(2_000);
  });

  it('le spese non riaddebitate hanno margine negativo, non assente', () => {
    // Sono costo puro: mostrarle a margine zero direbbe che si pareggiano.
    const summary = foldReport([aRow({ baseGrossCents: 10_000, rebillBaseCents: 0 })], PERIOD);

    const orphan = summary.byClient.find((bucket) => bucket.id === null);
    expect(orphan?.label).toBe('Non riaddebitata');
    expect(orphan?.theoreticalMarginCents).toBe(-10_000);
  });
});

describe('serie mensile', () => {
  it('copre tutti i mesi del periodo, anche quelli a zero', () => {
    // Un buco nella serie è un mese in cui non è stato pagato nulla, e va
    // visto: saltarlo comprimerebbe il grafico e nasconderebbe l'anomalia.
    const summary = foldReport([aRow({ dueDate: '2027-03-02', baseGrossCents: 7_000 })], PERIOD);

    expect(summary.byMonth.map((month) => month.month)).toEqual(['2027-01', '2027-02', '2027-03']);
    expect(summary.byMonth.map((month) => month.totalCents)).toEqual([0, 0, 7_000]);
  });

  it('un periodo dentro un mese solo dà un mese solo', () => {
    const summary = foldReport([], {
      from: d('2027-02-10'),
      to: d('2027-02-20'),
      baseCurrency: 'EUR',
    });

    expect(summary.byMonth.map((month) => month.month)).toEqual(['2027-02']);
  });

  it('attraversa il capodanno senza saltare dicembre', () => {
    const summary = foldReport([], {
      from: d('2026-11-15'),
      to: d('2027-01-15'),
      baseCurrency: 'EUR',
    });

    expect(summary.byMonth.map((month) => month.month)).toEqual(['2026-11', '2026-12', '2027-01']);
  });
});
