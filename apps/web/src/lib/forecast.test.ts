import { BP_SCALE, MAX_COST_ADJUSTMENT_BP, neutralLevers } from '@easygest/shared';
import { describe, expect, it } from 'vitest';

import { leversFromParams, yearChoices, yearFromParams } from './forecast';

/**
 * Che cosa vuol dire un indirizzo di `/previsioni`.
 *
 * È tutta la logica che in un componente vivrebbe dentro a un gestore di
 * eventi, e che qui si prova senza DOM perché è una funzione e un URL. Stesso
 * impianto e stessa ragione di `reports.test.ts`.
 */

/** Un «oggi» inchiodato: `yearChoices()` di default leggerebbe l'orologio. */
const TODAY = '2027-03-15';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe('l’anno', () => {
  it('senza parametro è quello in corso', () => {
    expect(yearFromParams(params(''), TODAY)).toBe(2027);
  });

  it('scritto in cifre è quello chiesto', () => {
    expect(yearFromParams(params('anno=2028'), TODAY)).toBe(2028);
  });

  it('malfatto ricade su quello in corso invece di rompere la pagina', () => {
    // Al contrario del periodo del report, che si mostra com'è: lì ci sono due
    // caselle da correggere, qui la tendina ha tre voci e nessuna può contenere
    // «duemila».
    for (const bad of ['duemila', '2027,5', '1200', '99999', '']) {
      expect(yearFromParams(params(`anno=${bad}`), TODAY)).toBe(2027);
    }
  });

  it('offre l’anno scorso, questo e il prossimo', () => {
    expect(yearChoices(TODAY)).toEqual([2026, 2027, 2028]);
  });
});

describe('le leve', () => {
  it('un indirizzo nudo dà le leve ferme', () => {
    expect(leversFromParams(params(''))).toEqual(neutralLevers());
  });

  it('legge importi in euro e aliquote in percento', () => {
    const levers = leversFromParams(
      params('fatturato=50000&costi=110&extra=200&coefficiente=78&inps=26,07&sostitutiva=15'),
    );

    expect(levers.revenueCents).toBe(5_000_000);
    expect(levers.costAdjustmentBp).toBe(11_000);
    expect(levers.extraMonthlyCents).toBe(20_000);
    expect(levers.rates).toEqual({
      profitabilityCoefficientBp: 7800,
      inpsRateBp: 2607,
      substituteTaxRateBp: 1500,
    });
  });

  it('un’aliquota non scritta non finisce fra quelle della leva', () => {
    // La differenza fra «provo un coefficiente diverso» e «azzero i
    // contributi»: una chiave assente vale «quella salvata», non zero.
    const levers = leversFromParams(params('inps=0'));

    expect(levers.rates).toEqual({ inpsRateBp: 0 });
  });

  it('separa le spese escluse e butta via gli spazi', () => {
    expect(leversFromParams(params('escluse=a, b ,,c')).excludedExpenseIds).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('un parametro illeggibile torna al valore neutro', () => {
    // È l'opposto della regola dei moduli — rifiutare invece di riparare — e la
    // differenza è che lì c'è una casella da colorare di rosso, qui c'è solo un
    // indirizzo incollato male da cui non si torna indietro.
    const levers = leversFromParams(params('fatturato=tanto&costi=parecchio&extra=un+po'));

    expect(levers.revenueCents).toBe(0);
    expect(levers.costAdjustmentBp).toBe(BP_SCALE);
    expect(levers.extraMonthlyCents).toBe(0);
  });

  it('non lascia passare un fatturato negativo né una percentuale assurda', () => {
    const levers = leversFromParams(params('fatturato=-50000&extra=-10&costi=100000'));

    expect(levers.revenueCents).toBe(0);
    expect(levers.extraMonthlyCents).toBe(0);
    expect(levers.costAdjustmentBp).toBe(MAX_COST_ADJUSTMENT_BP);
  });
});
