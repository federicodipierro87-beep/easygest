import { type ExtractedDocument, extractFromText } from '@easygest/shared/extraction';
import { describe, expect, it } from 'vitest';

import { type DocumentFormState, applyExtraction, documentForm } from './DocumentFormDialog';

const base: DocumentFormState = { ...documentForm(null, '2026-09-25'), title: 'Fattura Aruba' };
const nobody = { kind: null, clientId: null, vendorId: null };

const fromPdf = extractFromText(
  'FATTURA N. A26-7 del 15/03/2026\nImponibile 100,00\nTotale documento 122,00',
);

describe('applyExtraction', () => {
  it('riempie i campi non toccati e dice quali', () => {
    const { form, filled } = applyExtraction(base, new Set(), fromPdf, nobody);
    expect(form).toMatchObject({
      number: 'A26-7',
      issueDate: '2026-03-15',
      netCents: '100,00',
      grossCents: '122,00',
    });
    // Il tipo non compare: era già «fattura ricevuta», e il file dice lo stesso.
    expect(filled).toEqual(['numero', 'data', 'imponibile', 'totale']);
  });

  it('non tocca quello che l’utente ha scritto, nemmeno se il file dice altro', () => {
    // La lettura arriva qualche secondo dopo la scelta del file: chi nel
    // frattempo ha corretto il totale non deve vederselo cambiare sotto le dita.
    const edited = { ...base, grossCents: '150,00' };
    const { form, filled } = applyExtraction(
      edited,
      new Set(['grossCents'] as const),
      fromPdf,
      nobody,
    );
    expect(form.grossCents).toBe('150,00');
    expect(filled).not.toContain('totale');
  });

  it('sostituisce il tipo e la data di partenza, che nessuno ha scelto', () => {
    const f24 = extractFromText('MODELLO F24\nSALDO FINALE 1.536,40\nData 16/06/2026');
    const { form } = applyExtraction(base, new Set(), f24, nobody);
    expect(form.kind).toBe('F24');
    expect(form.issueDate).toBe('2026-06-16');
  });

  it('dalla fattura elettronica propone anche il titolo, con la controparte', () => {
    const invoice: ExtractedDocument = {
      ...fromPdf,
      source: 'fatturapa',
      supplier: { name: 'Aruba S.p.A.', vatNumber: '04552920482' },
      customer: null,
    };
    const { form } = applyExtraction(base, new Set(), invoice, {
      kind: 'INVOICE_PASSIVE',
      clientId: null,
      vendorId: 'v-aruba',
    });
    expect(form.title).toBe('Fattura A26-7 Aruba S.p.A.');
    expect(form.vendorId).toBe('v-aruba');
  });

  it('dal testo libero il titolo resta quello del file', () => {
    const { form } = applyExtraction(base, new Set(), fromPdf, nobody);
    expect(form.title).toBe('Fattura Aruba');
  });
});
