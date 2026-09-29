import { describe, expect, it } from 'vitest';

import { type Reading, toExtracted } from './document-reader';

const reading: Reading = {
  documentType: 'fattura',
  number: ' A26-000123 ',
  issueDate: '2026-03-15',
  dueDate: '2026-04-30',
  currency: 'EUR',
  netAmount: '100.00',
  vatRate: '22',
  vatAmount: '22.00',
  totalAmount: '1234.56',
  supplier: { name: 'Aruba S.p.A.', vatNumber: 'IT 04552920482' },
  customer: { name: 'Federico Rossi', vatNumber: null },
};

describe('toExtracted', () => {
  it('porta la risposta del modello nel formato delle altre letture', () => {
    expect(toExtracted(reading)).toEqual({
      source: 'ai',
      kind: 'INVOICE_PASSIVE',
      number: 'A26-000123',
      issueDate: '2026-03-15',
      dueDate: '2026-04-30',
      netCents: 10_000,
      vatRateBp: 2200,
      vatCents: 2_200,
      grossCents: 123_456,
      currency: 'EUR',
      supplier: { name: 'Aruba S.p.A.', vatNumber: '04552920482' },
      customer: { name: 'Federico Rossi', vatNumber: null },
      vatNumbers: ['04552920482'],
    });
  });

  it('scarta quello che lo schema non può escludere: date impossibili, importi non numerici', () => {
    // Lo schema garantisce che siano stringhe, non che abbiano senso.
    const odd = toExtracted({
      ...reading,
      issueDate: '2026-02-31',
      dueDate: '30/04/2026',
      totalAmount: 'centoventidue',
      currency: 'euro',
      vatRate: '150',
    });
    expect(odd).toMatchObject({
      issueDate: null,
      dueDate: null,
      grossCents: null,
      currency: null,
      vatRateBp: null,
    });
  });

  it('traduce il tipo, e «altro» resta da scegliere', () => {
    expect(toExtracted({ ...reading, documentType: 'f24' }).kind).toBe('F24');
    expect(toExtracted({ ...reading, documentType: 'nota_di_credito' }).kind).toBe(
      'INVOICE_PASSIVE',
    );
    expect(toExtracted({ ...reading, documentType: 'altro' }).kind).toBeNull();
  });

  it('tiene il prefisso di un paese estero', () => {
    const foreign = toExtracted({
      ...reading,
      supplier: { name: 'Google Ireland Ltd', vatNumber: 'IE6388047V' },
    });
    expect(foreign.supplier?.vatNumber).toBe('IE6388047V');
  });
});
