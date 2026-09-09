import { describe, expect, it } from 'vitest';

import {
  expenseInputSchema,
  expenseListQuerySchema,
  generatesOccurrences,
  occurrencePatchSchema,
  rebilledAmount,
  resolveAmount,
} from './expenses';
import { formatIsoDate } from './recurrence';

/** Il minimo che passa, su cui ogni prova cambia una cosa sola. */
const base = {
  name: 'Hosting',
  grossCents: 12_200,
  startDate: '2027-01-15',
};

function parse(overrides: Record<string, unknown> = {}) {
  return expenseInputSchema.safeParse({ ...base, ...overrides });
}

/** Il campo su cui il messaggio d'errore manda l'utente. */
function errorPaths(result: ReturnType<typeof parse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('importo', () => {
  it('dal lordo ricava imponibile e IVA', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.netCents).toBe(10_000);
    expect(result.data.grossCents).toBe(12_200);
  });

  it('dall\u2019imponibile ricava il totale', () => {
    const result = parse({ grossCents: undefined, netCents: 10_000 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.grossCents).toBe(12_200);
  });

  it('con entrambi tiene quello che dice la fattura, senza ricalcolare', () => {
    // Un fornitore che arrotonda l'IVA riga per riga produce un totale che non
    // coincide con l'aliquota applicata all'imponibile. Ha ragione la fattura.
    const result = parse({ netCents: 10_000, grossCents: 12_199 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.netCents).toBe(10_000);
    expect(result.data.grossCents).toBe(12_199);
  });

  it('rifiuta un totale minore dell\u2019imponibile', () => {
    expect(errorPaths(parse({ netCents: 10_000, grossCents: 9_000 }))).toContain('grossCents');
  });

  it('pretende almeno uno dei due', () => {
    expect(errorPaths(parse({ grossCents: undefined }))).toContain('grossCents');
  });

  it('accetta lo zero: un piano gratuito si segue per la data di rinnovo', () => {
    expect(parse({ grossCents: 0 }).success).toBe(true);
  });

  it('rifiuta un importo negativo', () => {
    expect(parse({ grossCents: -100 }).success).toBe(false);
  });

  it('con IVA a zero netto e lordo coincidono', () => {
    const result = parse({ vatRateBp: 0 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.netCents).toBe(12_200);
  });
});

describe('resolveAmount', () => {
  it('lo scorporo torna sempre: netto pi\u00f9 IVA fa il lordo', () => {
    for (const gross of [1, 99, 100, 1_049, 12_199, 999_999]) {
      const resolved = resolveAmount({ grossCents: gross, vatRateBp: 2200 });
      expect(resolved.netCents + resolved.vatCents).toBe(gross);
    }
  });
});

describe('ricorrenza', () => {
  it('una tantum non ha intervallo, n\u00e9 fine, n\u00e9 disdetta', () => {
    expect(errorPaths(parse({ recurrenceUnit: 'ONE_OFF', recurrenceInterval: 3 }))).toContain(
      'recurrenceInterval',
    );
    expect(errorPaths(parse({ recurrenceUnit: 'ONE_OFF', endDate: '2028-01-01' }))).toContain(
      'endDate',
    );
    expect(errorPaths(parse({ recurrenceUnit: 'ONE_OFF', cancellationNoticeDays: 30 }))).toContain(
      'cancellationNoticeDays',
    );
  });

  it('una tantum senza fronzoli passa', () => {
    expect(parse({ recurrenceUnit: 'ONE_OFF' }).success).toBe(true);
  });

  it('rifiuta una fine che precede l\u2019inizio', () => {
    expect(errorPaths(parse({ endDate: '2026-12-31' }))).toContain('endDate');
  });

  it('accetta una fine uguale all\u2019inizio', () => {
    expect(parse({ endDate: base.startDate }).success).toBe(true);
  });

  it('le date escono come giorni di calendario, non come istanti', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(formatIsoDate(result.data.startDate)).toBe('2027-01-15');
    expect(result.data.startDate.getUTCHours()).toBe(0);
  });

  it('rifiuta una data che non esiste', () => {
    expect(parse({ startDate: '2027-02-30' }).success).toBe(false);
  });
});

describe('riaddebito', () => {
  it('senza cliente non ha destinatario', () => {
    expect(errorPaths(parse({ rebillMode: 'PASSTHROUGH' }))).toContain('clientId');
  });

  it('con ricarico pretende la percentuale', () => {
    expect(errorPaths(parse({ rebillMode: 'MARKUP', clientId: 'abc' }))).toContain(
      'rebillMarkupBp',
    );
  });

  it('a forfait pretende l\u2019importo', () => {
    expect(errorPaths(parse({ rebillMode: 'FIXED', clientId: 'abc' }))).toContain(
      'rebillAmountCents',
    );
  });

  it('rifiuta i campi accessori quando non c\u2019entrano', () => {
    // Un ricarico lasciato lì da un cambio di modalità è un numero che non
    // verrà mai applicato ma che si legge come se lo fosse.
    expect(errorPaths(parse({ rebillMarkupBp: 2000 }))).toContain('rebillMarkupBp');
    expect(
      errorPaths(
        parse({
          rebillMode: 'MARKUP',
          clientId: 'abc',
          rebillMarkupBp: 2000,
          rebillAmountCents: 500,
        }),
      ),
    ).toContain('rebillAmountCents');
  });

  it('le combinazioni giuste passano', () => {
    expect(parse({ rebillMode: 'MARKUP', clientId: 'abc', rebillMarkupBp: 2000 }).success).toBe(
      true,
    );
    expect(parse({ rebillMode: 'FIXED', clientId: 'abc', rebillAmountCents: 15_000 }).success).toBe(
      true,
    );
  });
});

describe('calcolo del riaddebito', () => {
  it('senza riaddebito non c\u2019\u00e8 importo, che non \u00e8 zero', () => {
    // Zero direbbe «riaddebitato gratis», che è un'altra informazione.
    expect(
      rebilledAmount({ rebillMode: 'NONE', rebillMarkupBp: null, rebillAmountCents: null }, 12_200),
    ).toBeNull();
  });

  it('al costo riaddebita il lordo, perch\u00e9 in forfettario l\u2019IVA \u00e8 un costo', () => {
    expect(
      rebilledAmount(
        { rebillMode: 'PASSTHROUGH', rebillMarkupBp: null, rebillAmountCents: null },
        12_200,
      ),
    ).toBe(12_200);
  });

  it('il ricarico arrotonda come il resto del progetto', () => {
    // 1049 + 20% = 1258,8 → 1259, non 1258.
    expect(
      rebilledAmount(
        { rebillMode: 'MARKUP', rebillMarkupBp: 2000, rebillAmountCents: null },
        1_049,
      ),
    ).toBe(1_259);
  });

  it('a forfait ignora il costo', () => {
    expect(
      rebilledAmount(
        { rebillMode: 'FIXED', rebillMarkupBp: null, rebillAmountCents: 20_000 },
        12_200,
      ),
    ).toBe(20_000);
  });
});

describe('valuta', () => {
  it('normalizza a maiuscolo', () => {
    const result = parse({ currency: 'usd' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.currency).toBe('USD');
  });

  it('rifiuta quello che non \u00e8 un codice ISO', () => {
    expect(parse({ currency: 'dollari' }).success).toBe(false);
    expect(parse({ currency: '€' }).success).toBe(false);
  });
});

describe('stato', () => {
  it('solo le attive generano occorrenze', () => {
    expect(generatesOccurrences('ACTIVE')).toBe(true);
    expect(generatesOccurrences('PAUSED')).toBe(false);
    expect(generatesOccurrences('CANCELLED')).toBe(false);
    expect(generatesOccurrences('ENDED')).toBe(false);
  });
});

describe('campi sconosciuti', () => {
  it('vengono rifiutati invece che ignorati', () => {
    // `sortOrder` su una spesa non esiste: ignorarlo farebbe credere di aver
    // salvato qualcosa che non è stato salvato.
    expect(parse({ isSystem: true }).success).toBe(false);
  });
});

describe('filtri dell\u2019elenco', () => {
  it('i valori di default reggono una query vuota', () => {
    const result = expenseListQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.page).toBe(1);
    expect(result.data.sort).toBe('name');
  });

  it('non ha il filtro degli archiviati', () => {
    // Una spesa cambia stato, non si archivia: i quattro stati non stanno in
    // un booleano.
    expect(expenseListQuerySchema.safeParse({ archived: 'only' }).success).toBe(true);
    const result = expenseListQuerySchema.safeParse({});
    expect(result.success && 'archived' in result.data).toBe(false);
  });

  it('legge la finestra di scadenza', () => {
    const result = expenseListQuerySchema.safeParse({ dueFrom: '2027-01-01', dueTo: '2027-12-31' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(formatIsoDate(result.data.dueFrom!)).toBe('2027-01-01');
  });
});

describe('modifica di un\u2019occorrenza', () => {
  it('accetta una modifica parziale', () => {
    const result = occurrencePatchSchema.safeParse({ status: 'PAID' });
    expect(result.success).toBe(true);
  });

  it('accetta la correzione dell\u2019importo', () => {
    // È il motivo per cui esiste il «da confermare»: il fornitore ha alzato
    // il prezzo e la cifra va corretta.
    expect(occurrencePatchSchema.safeParse({ grossCents: 13_000 }).success).toBe(true);
  });

  it('rifiuta i campi che il motore possiede', () => {
    expect(occurrencePatchSchema.safeParse({ dueDate: '2027-03-15' }).success).toBe(false);
    expect(occurrencePatchSchema.safeParse({ expenseId: 'abc' }).success).toBe(false);
  });
});
