import { describe, expect, it } from 'vitest';

import type { Settings } from './settings';
import {
  FORFETTARIO_HARD_LIMIT_CENTS,
  FORFETTARIO_LIMIT_CENTS,
  foldForfettario,
  revenueWarning,
  simulatorRefusal,
} from './taxes';

/**
 * Il rischio numero uno di questa fase è un numero fiscale sbagliato che sembra
 * giusto: nessun errore, nessun test rosso, solo una cifra credibile su cui
 * qualcuno accantona dei soldi. Le fixture qui sotto sono in interi e verificate
 * a mano, e il caso principale passa proprio per il mezzo centesimo — l'unico
 * punto in cui l'arrotondamento si vede.
 */

const RATES = {
  profitabilityCoefficientBp: 6700,
  inpsRateBp: 2607,
  substituteTaxRateBp: 500,
};

describe('foldForfettario', () => {
  it('il caso del mezzo centesimo, arrotondato half-up', () => {
    // 50.000 € → imponibile 33.500 € → INPS 8.733,45 € → base 24.766,55 €
    // → imposta 1.238,3275 €, che è esattamente mezzo centesimo: half-up.
    const result = foldForfettario({ revenueCents: 5_000_000, ...RATES });

    expect(result.taxableCents).toBe(3_350_000);
    expect(result.inpsCents).toBe(873_345);
    expect(result.substituteBaseCents).toBe(2_476_655);
    expect(result.substituteTaxCents).toBe(123_833);
    expect(result.totalDueCents).toBe(997_178);
  });

  it('il dovuto è la somma delle sue due parti, e nient’altro', () => {
    const result = foldForfettario({ revenueCents: 3_712_900, ...RATES });

    expect(result.totalDueCents).toBe(result.inpsCents + result.substituteTaxCents);
  });

  it('i contributi versati sono quelli di competenza se non si dice altro', () => {
    // È il default dichiarato: `contributionsPaidCents` assente deduce l'INPS
    // di competenza, che a regime si compensa e nel primo anno no.
    const competenza = foldForfettario({ revenueCents: 5_000_000, ...RATES });
    const esplicito = foldForfettario({
      revenueCents: 5_000_000,
      ...RATES,
      contributionsPaidCents: competenza.inpsCents,
    });

    expect(esplicito).toEqual(competenza);
  });

  it('nel primo anno, senza contributi versati, l’imposta è più alta', () => {
    // Non è un difetto del conto ma il motivo per cui il parametro esiste:
    // l'errore per competenza vale ~437 € su 50.000 € di fatturato.
    const primoAnno = foldForfettario({
      revenueCents: 5_000_000,
      ...RATES,
      contributionsPaidCents: 0,
    });

    expect(primoAnno.substituteBaseCents).toBe(3_350_000);
    expect(primoAnno.substituteTaxCents).toBe(167_500);
    expect(primoAnno.substituteTaxCents - 123_833).toBe(43_667);
  });

  it('contributi versati oltre l’imponibile non producono un’imposta negativa', () => {
    // Succede al secondo anno, quando saldo e acconto cadono insieme su un
    // imponibile calato. Una base negativa darebbe un credito che non esiste:
    // si tronca a zero, e il troncamento è fra i limiti dichiarati.
    const result = foldForfettario({
      revenueCents: 1_000_000,
      ...RATES,
      contributionsPaidCents: 2_000_000,
    });

    expect(result.substituteBaseCents).toBe(0);
    expect(result.substituteTaxCents).toBe(0);
    expect(result.totalDueCents).toBe(result.inpsCents);
  });

  it('con aliquote a zero non deve nulla, senza dividere per zero', () => {
    const result = foldForfettario({
      revenueCents: 5_000_000,
      profitabilityCoefficientBp: 6700,
      inpsRateBp: 0,
      substituteTaxRateBp: 0,
    });

    expect(result.inpsCents).toBe(0);
    expect(result.substituteBaseCents).toBe(3_350_000);
    expect(result.substituteTaxCents).toBe(0);
    expect(result.totalDueCents).toBe(0);
  });

  it('a fatturato zero è tutto zero', () => {
    const result = foldForfettario({ revenueCents: 0, ...RATES });

    expect(result).toEqual({
      taxableCents: 0,
      inpsCents: 0,
      substituteBaseCents: 0,
      substituteTaxCents: 0,
      totalDueCents: 0,
    });
  });

  it('le aliquote vengono dal parametro, non da costanti nel codice', () => {
    // È la difesa contro il numero sbagliato che sembra giusto: cambiando il
    // coefficiente in `Settings` il conto cambia, e se non cambiasse vorrebbe
    // dire che da qualche parte c'è un 67 scritto a mano.
    const ridotto = foldForfettario({
      revenueCents: 5_000_000,
      ...RATES,
      profitabilityCoefficientBp: 7800,
    });

    expect(ridotto.taxableCents).toBe(3_900_000);
  });
});

describe('revenueWarning', () => {
  it('sotto le soglie non dice niente', () => {
    expect(revenueWarning(5_000_000)).toBeNull();
    expect(revenueWarning(FORFETTARIO_LIMIT_CENTS)).toBeNull();
  });

  it('oltre 85.000 € dice che il cambio è dall’anno prossimo', () => {
    // Il messaggio deve dire che i numeri di quest'anno restano validi,
    // altrimenti sembra che il conto a schermo sia sbagliato.
    const message = revenueWarning(FORFETTARIO_LIMIT_CENTS + 1);

    expect(message).not.toBeNull();
    expect(message).toContain('85.000');
    expect(message).toContain('anno prossimo');
  });

  it('oltre 100.000 € dice che la decadenza è immediata', () => {
    const message = revenueWarning(FORFETTARIO_HARD_LIMIT_CENTS + 1);

    expect(message).not.toBeNull();
    expect(message).toContain('100.000');
    expect(message).toContain('stesso anno');
  });

  it('i due messaggi sono diversi, perché i due casi lo sono', () => {
    // Uno dice «da gennaio cambia regime», l'altro «i numeri qui sotto non
    // valgono». Un testo solo sarebbe falso in uno dei due casi.
    expect(revenueWarning(9_000_000)).not.toBe(revenueWarning(11_000_000));
  });
});

describe('simulatorRefusal', () => {
  const settings = (taxRegime: Settings['taxRegime']): Settings => ({
    taxRegime,
    substituteTaxRateBp: 500,
    profitabilityCoefficientBp: 6700,
    inpsRateBp: 2607,
    defaultVatRateBp: 2200,
    baseCurrency: 'EUR',
    timezone: 'Europe/Rome',
    reminderDaysBefore: [30, 7, 1],
    cancellationReminderDaysBefore: [60, 30, 15],
    digestEnabled: true,
    digestDayOfWeek: 1,
    updatedAt: '2027-03-15T06:00:00.000Z',
  });

  it('in forfettario non rifiuta', () => {
    expect(simulatorRefusal(settings('FORFETTARIO'))).toBeNull();
  });

  it('in ordinario rifiuta invece di approssimare', () => {
    const message = simulatorRefusal(settings('ORDINARIO'));

    expect(message).not.toBeNull();
    expect(message).toContain('IRPEF');
  });
});
