import { describe, expect, it } from 'vitest';

import { expiresBefore, paymentMethodInputSchema } from './payment-methods';

function parse(input: Record<string, unknown>) {
  return paymentMethodInputSchema.parse({ label: 'Carta principale', type: 'CARD', ...input });
}

describe('scadenza di una carta', () => {
  it('vuole mese e anno insieme, o nessuno dei due', () => {
    /**
     * Un mese senza anno non è mezza scadenza, è un dato inservibile: senza
     * questo controllo si salverebbe senza che nessuno protesti, e il
     * promemoria della Fase 4 lo troverebbe lì senza poterci fare niente.
     */
    expect(() => parse({ expiryMonth: 3 })).toThrow();
    expect(() => parse({ expiryYear: 2027 })).toThrow();

    expect(parse({ expiryMonth: 3, expiryYear: 2027 }).expiryMonth).toBe(3);
    expect(parse({}).expiryMonth).toBeNull();
  });

  it('non scambia la casella vuota per il mese zero', () => {
    /**
     * È il motivo per cui esiste `optionalNumber`. `z.coerce.number('')` vale
     * `0`, quindi senza la conversione preventiva una casella non compilata
     * diventerebbe un mese di scadenza pari a zero — che poi fallirebbe il
     * `min(1)` dicendo «il mese va da 1 a 12» su un campo che l'utente non ha
     * nemmeno toccato.
     */
    const parsed = parse({ expiryMonth: '', expiryYear: '' });

    expect(parsed.expiryMonth).toBeNull();
    expect(parsed.expiryYear).toBeNull();
  });

  it('rifiuta un mese fuori dai dodici', () => {
    expect(() => parse({ expiryMonth: 13, expiryYear: 2027 })).toThrow();
    expect(() => parse({ expiryMonth: 0, expiryYear: 2027 })).toThrow();
  });

  it('accetta una carta già scaduta', () => {
    // Registrare la carta scaduta il mese scorso serve proprio a scoprire
    // quali abbonamenti vanno spostati: rifiutarla vieterebbe l'unico momento
    // in cui quel dato è urgente.
    expect(parse({ expiryMonth: 1, expiryYear: 2020 }).expiryYear).toBe(2020);
  });

  it('considera valida tutta l’ultima mensilità', () => {
    /**
     * 03/2027 significa «fino alla fine di marzo». Il confine è l'inizio di
     * aprile: calcolarlo sul mese stesso dichiarerebbe la carta morta mentre
     * funziona ancora, e sposterebbe di trenta giorni ogni promemoria.
     */
    expect(expiresBefore(3, 2027).toISOString()).toBe('2027-04-01T00:00:00.000Z');
    // Dicembre deve traboccare nell'anno dopo, non nel mese tredici.
    expect(expiresBefore(12, 2027).toISOString()).toBe('2028-01-01T00:00:00.000Z');
  });
});

describe('ultime quattro cifre', () => {
  it('ne vuole esattamente quattro', () => {
    expect(parse({ last4: '4321' }).last4).toBe('4321');
    expect(() => parse({ last4: '432' })).toThrow();
    expect(() => parse({ last4: '43210' })).toThrow();
    expect(() => parse({ last4: '4a21' })).toThrow();
  });

  it('è ammesso anche fuori dalle carte', () => {
    // Le ultime quattro di un IBAN identificano un addebito SEPA allo stesso
    // modo: vincolarle al tipo CARD costringerebbe a scriverle nelle note.
    expect(parse({ type: 'SEPA_DIRECT_DEBIT', last4: '0199' }).last4).toBe('0199');
  });
});

describe('tipo di pagamento', () => {
  it('è obbligatorio e chiuso', () => {
    // Senza tipo non si può né raggruppare né decidere cosa mostrare: a
    // differenza del colore di una categoria, qui non esiste un default sensato.
    expect(() => paymentMethodInputSchema.parse({ label: 'Qualcosa' })).toThrow();
    expect(() => paymentMethodInputSchema.parse({ label: 'X', type: 'BITCOIN' })).toThrow();
  });
});
