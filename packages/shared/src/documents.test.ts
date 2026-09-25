import { describe, expect, it } from 'vitest';

import {
  documentInputSchema,
  documentUploadRequestSchema,
  mimeTypeFromFileName,
} from './documents';

const base = { kind: 'INVOICE_PASSIVE', title: 'Fattura', issueDate: '2026-03-15' };

describe('documentInputSchema', () => {
  it('non completa gli importi: registra solo quello che c\u2019è scritto', () => {
    // Un totale senza imponibile resta un totale senza imponibile: inventare
    // l'altra metà scriverebbe nell'archivio un numero che sul foglio non c'è.
    const parsed = documentInputSchema.parse({ ...base, grossCents: 12_200 });
    expect(parsed.grossCents).toBe(12_200);
    expect(parsed.netCents).toBeNull();
    expect(parsed.vatCents).toBeNull();
  });

  it('normalizza le etichette: minuscole, senza doppioni, in ordine', () => {
    const parsed = documentInputSchema.parse({ ...base, tags: ['INPS', ' f24 ', 'inps'] });
    expect(parsed.tags).toEqual(['f24', 'inps']);
  });

  it('rifiuta un periodo che finisce prima di cominciare', () => {
    const result = documentInputSchema.safeParse({
      ...base,
      periodStart: '2026-03-01',
      periodEnd: '2026-02-01',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['periodEnd']);
  });

  it('tiene ogni fattura dalla sua parte: cliente per le emesse, fornitore per le ricevute', () => {
    expect(
      documentInputSchema.safeParse({ ...base, kind: 'INVOICE_ACTIVE', vendorId: 'v' }).success,
    ).toBe(false);
    expect(documentInputSchema.safeParse({ ...base, clientId: 'c' }).success).toBe(false);
    // Un contratto può avere tutte e due le controparti, o nessuna.
    expect(
      documentInputSchema.safeParse({ ...base, kind: 'CONTRACT', clientId: 'c', vendorId: 'v' })
        .success,
    ).toBe(true);
  });
});

describe('documentUploadRequestSchema', () => {
  const upload = {
    fileName: 'fattura.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    checksumSha256: 'A'.repeat(64),
  };

  it('accetta l\u2019impronta in maiuscolo e la normalizza', () => {
    expect(documentUploadRequestSchema.parse(upload).checksumSha256).toBe('a'.repeat(64));
  });

  it('rifiuta un file vuoto e un tipo fuori elenco', () => {
    expect(documentUploadRequestSchema.safeParse({ ...upload, sizeBytes: 0 }).success).toBe(false);
    expect(
      documentUploadRequestSchema.safeParse({ ...upload, mimeType: 'text/html' }).success,
    ).toBe(false);
  });
});

describe('mimeTypeFromFileName', () => {
  it('riconosce la fattura elettronica, anche firmata', () => {
    expect(mimeTypeFromFileName('IT01234567890_00001.xml')).toBe('application/xml');
    expect(mimeTypeFromFileName('IT01234567890_00001.XML.P7M')).toBe('application/pkcs7-mime');
    expect(mimeTypeFromFileName('Scansione.JPG')).toBe('image/jpeg');
    expect(mimeTypeFromFileName('nota.docx')).toBeNull();
  });
});
