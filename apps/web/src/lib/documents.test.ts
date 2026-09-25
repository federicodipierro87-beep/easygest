import { describe, expect, it } from 'vitest';

import { counterparts, documentForm, toDocumentInput } from '../components/DocumentFormDialog';
import {
  DEFAULT_DOCUMENT_FILTERS,
  documentQueryString,
  formatFileSize,
  mimeTypeOf,
  titleFromFileName,
} from './documents';

describe('documentQueryString', () => {
  it('non manda niente con i filtri di partenza', () => {
    // La più recente per prima è il default anche del server: ripeterlo
    // nell'indirizzo sarebbe una chiave di cache diversa per la stessa lista.
    expect(documentQueryString(DEFAULT_DOCUMENT_FILTERS)).toBe('');
  });

  it('manda solo i filtri scelti', () => {
    const query = documentQueryString({
      ...DEFAULT_DOCUMENT_FILTERS,
      q: 'aruba',
      kind: 'F24',
      from: '2026-01-01',
      sort: 'title',
      direction: 'asc',
    });
    expect(new URLSearchParams(query).toString()).toBe(
      'q=aruba&kind=F24&from=2026-01-01&sort=title&direction=asc',
    );
  });
});

describe('dal file al documento', () => {
  it('propone un titolo dal nome del file', () => {
    expect(titleFromFileName('Fattura_Aruba_2026-03.pdf')).toBe('Fattura Aruba 2026-03');
    // La fattura elettronica firmata ha due estensioni, e vanno via tutte e due.
    expect(titleFromFileName('IT01234567890_00001.xml.p7m')).toBe('IT01234567890 00001');
  });

  it('preferisce l\u2019estensione al tipo dichiarato dal browser', () => {
    expect(mimeTypeOf({ name: 'fattura.xml.p7m', type: '' })).toBe('application/pkcs7-mime');
    expect(mimeTypeOf({ name: 'fattura.xml', type: 'text/xml' })).toBe('application/xml');
    expect(mimeTypeOf({ name: 'senza-estensione', type: 'application/pdf' })).toBe(
      'application/pdf',
    );
    expect(mimeTypeOf({ name: 'pagina.html', type: 'text/html' })).toBeNull();
  });

  it('scrive le dimensioni come le legge una persona', () => {
    expect(formatFileSize(900)).toBe('900 B');
    expect(formatFileSize(312 * 1024)).toBe('312 kB');
    expect(formatFileSize(2.4 * 1024 * 1024)).toBe('2,4 MB');
  });
});

describe('il modulo del documento', () => {
  const form = { ...documentForm(null, '2026-03-15'), title: 'Fattura' };

  it('lascia vuoti gli importi non scritti, e l\u2019IVA è la differenza', () => {
    const only = toDocumentInput({ ...form, grossCents: '122,00' });
    expect(only.ok && only.input).toMatchObject({
      grossCents: 12_200,
      netCents: null,
      vatCents: null,
    });

    const both = toDocumentInput({ ...form, netCents: '100', grossCents: '122' });
    expect(both.ok && both.input.vatCents).toBe(2_200);
  });

  it('ferma un importo che non è un numero', () => {
    const prepared = toDocumentInput({ ...form, grossCents: 'dodici' });
    expect(prepared).toEqual({ ok: false, errors: { grossCents: 'Questo non è un numero' } });
  });

  it('non manda la controparte che il tipo non prevede', () => {
    // Si era scelto un fornitore, poi si è cambiato tipo in «fattura emessa»:
    // la casella è sparita, e il valore rimasto non deve partire.
    const prepared = toDocumentInput({ ...form, kind: 'INVOICE_ACTIVE', vendorId: 'v1' });
    expect(prepared.ok && prepared.input.vendorId).toBeNull();
    expect(counterparts('CONTRACT')).toEqual({ client: true, vendor: true });
  });

  it('divide le etichette sulla virgola', () => {
    const prepared = toDocumentInput({ ...form, tags: 'inps, saldo ,, 2026' });
    expect(prepared.ok && prepared.input.tags).toEqual(['inps', 'saldo', '2026']);
  });
});
