import { describe, expect, it } from 'vitest';

import { linesFromTextItems } from './extract';

const at = (str: string, y: number, hasEOL = false) => ({
  str,
  transform: [1, 0, 0, 1, 0, y],
  hasEOL,
});

describe('linesFromTextItems', () => {
  it('tiene sulla stessa riga le celle alla stessa quota', () => {
    // Due celle di tabella, senza fine riga dichiarata fra loro: è il caso in
    // cui «Totale» e il suo importo rischiano di separarsi.
    expect(
      linesFromTextItems([at('Totale documento', 100), at('€ 122,00', 100), at('Scadenza', 80)]),
    ).toEqual(['Totale documento € 122,00', 'Scadenza']);
  });

  it('va a capo quando pdf.js lo dice, e salta i frammenti vuoti', () => {
    expect(
      linesFromTextItems([at('FATTURA N. 1', 100, true), at('', 100), at('del 15/03/2026', 100)]),
    ).toEqual(['FATTURA N. 1', 'del 15/03/2026']);
  });

  it('ignora i marcatori di contenuto che non sono testo', () => {
    expect(linesFromTextItems([{ type: 'beginMarkedContent' }, at('Ricevuta', 10)])).toEqual([
      'Ricevuta',
    ]);
  });
});
