import { describe, expect, it } from 'vitest';

import {
  applyBasisPoints,
  centsToDecimalString,
  divideRoundHalfUp,
  formatBasisPoints,
  formatCents,
  grossFromNet,
  MoneyError,
  parseAmountToCents,
  splitGross,
  sumCents,
  vatFromNet,
} from './money';

describe('divideRoundHalfUp', () => {
  it('arrotonda .5 lontano dallo zero in modo simmetrico', () => {
    expect(divideRoundHalfUp(5, 2)).toBe(3);
    expect(divideRoundHalfUp(-5, 2)).toBe(-3);
    expect(divideRoundHalfUp(5, -2)).toBe(-3);
    expect(divideRoundHalfUp(-5, -2)).toBe(3);
  });

  it('non introduce la deriva di Math.round sui valori negativi', () => {
    // Math.round(-2.5) vale -2: su una nota di credito sarebbe un centesimo
    // che non torna con la fattura di origine.
    expect(divideRoundHalfUp(-25, 10)).toBe(-3);
    expect(Math.round(-2.5)).toBe(-2);
  });

  it('arrotonda per difetto sotto la metà e per eccesso sopra', () => {
    expect(divideRoundHalfUp(4, 10)).toBe(0);
    expect(divideRoundHalfUp(6, 10)).toBe(1);
    expect(divideRoundHalfUp(-4, 10)).toBe(0);
    expect(divideRoundHalfUp(-6, 10)).toBe(-1);
  });

  it('rifiuta la divisione per zero', () => {
    expect(() => divideRoundHalfUp(1, 0)).toThrow(MoneyError);
  });
});

describe('applyBasisPoints', () => {
  it('applica aliquote intere e frazionarie', () => {
    expect(applyBasisPoints(10_000, 2200)).toBe(2200); // 100,00 € al 22%
    expect(applyBasisPoints(10_000, 2607)).toBe(2607); // INPS gestione separata
    expect(applyBasisPoints(10_000, 500)).toBe(500); // imposta sostitutiva 5%
  });

  it('arrotonda al centesimo quando la percentuale non è esatta', () => {
    // 9,99 € al 22% = 2,1978 € -> 2,20 €
    expect(applyBasisPoints(999, 2200)).toBe(220);
    // 0,01 € al 22% = 0,0022 € -> 0,00 €
    expect(applyBasisPoints(1, 2200)).toBe(0);
  });

  it('rifiuta importi non interi', () => {
    expect(() => applyBasisPoints(10.5, 2200)).toThrow(MoneyError);
  });
});

describe('IVA', () => {
  it('calcola imponibile, imposta e totale in modo coerente', () => {
    const netCents = 12_345;
    const vatCents = vatFromNet(netCents, 2200);
    expect(vatCents).toBe(2716); // 27,159 -> 27,16
    expect(grossFromNet(netCents, 2200)).toBe(netCents + vatCents);
  });

  it('gestisce l’aliquota zero del regime forfettario', () => {
    expect(vatFromNet(50_000, 0)).toBe(0);
    expect(grossFromNet(50_000, 0)).toBe(50_000);
  });

  it('scorpora un totale garantendo che imponibile e imposta lo ricompongano', () => {
    for (const gross of [100, 999, 1220, 12_345, 999_999]) {
      const { netCents, vatCents } = splitGross(gross, 2200);
      expect(netCents + vatCents).toBe(gross);
    }
  });

  it('scorpora 122,00 € al 22% in 100,00 € più 22,00 €', () => {
    expect(splitGross(12_200, 2200)).toEqual({ netCents: 10_000, vatCents: 2200 });
  });
});

describe('sumCents', () => {
  it('somma importi interi', () => {
    expect(sumCents([1000, -250, 3])).toBe(753);
    expect(sumCents([])).toBe(0);
  });

  it('rifiuta un float che si è infilato nella lista', () => {
    expect(() => sumCents([1000, 2.5])).toThrow(MoneyError);
  });
});

describe('parseAmountToCents', () => {
  it('interpreta il formato italiano', () => {
    expect(parseAmountToCents('1.234,56')).toBe(123_456);
    expect(parseAmountToCents('1234,56')).toBe(123_456);
    expect(parseAmountToCents('1.234.567,89')).toBe(123_456_789);
    expect(parseAmountToCents('1.234')).toBe(123_400);
  });

  it('interpreta il formato anglosassone', () => {
    expect(parseAmountToCents('1,234.56')).toBe(123_456);
    expect(parseAmountToCents('1234.56')).toBe(123_456);
  });

  it('tollera simboli di valuta e spazi, anche unicode', () => {
    expect(parseAmountToCents('€ 1.234,56')).toBe(123_456);
    expect(parseAmountToCents('  49,90  ')).toBe(4990);
    expect(parseAmountToCents('1\u00a0234,50')).toBe(123_450);
    expect(parseAmountToCents('$19.99')).toBe(1999);
  });

  it('gestisce decimali parziali, interi e segno', () => {
    expect(parseAmountToCents('12,5')).toBe(1250);
    expect(parseAmountToCents('12')).toBe(1200);
    expect(parseAmountToCents(',5')).toBe(50);
    expect(parseAmountToCents('-12,50')).toBe(-1250);
    expect(parseAmountToCents('0')).toBe(0);
  });

  it('restituisce null su input non interpretabile invece di indovinare', () => {
    expect(parseAmountToCents('')).toBeNull();
    expect(parseAmountToCents('   ')).toBeNull();
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents('-')).toBeNull();
    expect(parseAmountToCents('12,345')).toBeNull(); // tre decimali: ambiguo
    expect(parseAmountToCents('1,2,3')).toBeNull();
  });
});

describe('formattazione', () => {
  it('produce una stringa decimale neutra per CSV e log', () => {
    expect(centsToDecimalString(123_456)).toBe('1234.56');
    expect(centsToDecimalString(-5)).toBe('-0.05');
    expect(centsToDecimalString(0)).toBe('0.00');
    expect(centsToDecimalString(100)).toBe('1.00');
  });

  it('formatta gli importi in italiano', () => {
    // Intl usa lo spazio unicode non separabile prima del simbolo.
    expect(formatCents(123_456).replace(/\u00a0/g, ' ')).toBe('1.234,56 €');
    expect(formatCents(1999, { currency: 'USD', locale: 'en-US' })).toBe('$19.99');
    expect(formatCents(123_456, { showSymbol: false })).toBe('1.234,56');
  });

  it('formatta le aliquote', () => {
    expect(formatBasisPoints(2200)).toBe('22%');
    expect(formatBasisPoints(2607)).toBe('26,07%');
    expect(formatBasisPoints(6700)).toBe('67%');
  });
});
