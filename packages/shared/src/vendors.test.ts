import { describe, expect, it } from 'vitest';

import { vendorInputSchema } from './vendors';

/**
 * Il fornitore condivide con il cliente la validazione fiscale, già provata
 * altrove. Qui interessano i campi che ha soltanto lui — quelli che servono a
 * ritrovare il contratto il giorno in cui bisogna disdire.
 */
describe('anagrafica fornitore', () => {
  it('accetta un indirizzo scritto come lo si copia dalla barra del browser', () => {
    const vendor = vendorInputSchema.parse({
      name: 'Aruba',
      website: 'aruba.it',
      portalUrl: 'https://admin.aruba.it/pannello',
      accountRef: '  AR-99812  ',
    });

    expect(vendor.website).toBe('https://aruba.it/');
    expect(vendor.portalUrl).toBe('https://admin.aruba.it/pannello');
    expect(vendor.accountRef).toBe('AR-99812');
  });

  it('non lascia archiviare un indirizzo che non sia http', () => {
    // Sito e pannello vengono mostrati come collegamenti cliccabili: sono
    // esattamente i due campi da cui un `javascript:` arriverebbe in pagina.
    const result = vendorInputSchema.safeParse({ name: 'X', portalUrl: 'javascript:alert(1)' });

    expect(result.success).toBe(false);
  });

  it('non ha i campi del cliente', () => {
    // Da un fornitore si riceve e basta: codice SDI e indirizzo di
    // fatturazione qui non servono, e accettarli darebbe l'impressione che
    // vengano usati.
    const result = vendorInputSchema.safeParse({ name: 'X', sdiCode: 'ABCDEFG' });

    expect(result.success).toBe(false);
  });
});
