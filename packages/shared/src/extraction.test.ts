import { describe, expect, it } from 'vitest';

import {
  amountsIn,
  datesIn,
  extractFromText,
  extractXmlFromP7m,
  parseFatturaPA,
  resolveCounterparty,
  vatNumbersIn,
} from './extraction';

/** Una fattura elettronica ridotta all'osso, com'è davvero nei campi che contano. */
const FATTURA = `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <FatturaElettronicaHeader>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>04552920482</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Aruba S.p.A.</Denominazione></Anagrafica>
      </DatiAnagrafici>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <CodiceFiscale>RSSFDR87A01H501X</CodiceFiscale>
        <Anagrafica><Nome>Federico</Nome><Cognome>Rossi</Cognome></Anagrafica>
      </DatiAnagrafici>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Divisa>EUR</Divisa>
        <Data>2026-03-15</Data>
        <Numero>FPR 12/26 &amp; bis</Numero>
        <ImportoTotaleDocumento>134.20</ImportoTotaleDocumento>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>
      <DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>100.00</ImponibileImporto><Imposta>22.00</Imposta></DatiRiepilogo>
      <DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>10.00</ImponibileImporto><Imposta>2.20</Imposta></DatiRiepilogo>
    </DatiBeniServizi>
    <DatiPagamento><DettaglioPagamento><DataScadenzaPagamento>2026-04-15</DataScadenzaPagamento></DettaglioPagamento></DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;

describe('fattura elettronica', () => {
  it('legge numero, date, importi e le due parti', () => {
    expect(parseFatturaPA(FATTURA)).toMatchObject({
      source: 'fatturapa',
      number: 'FPR 12/26 & bis',
      issueDate: '2026-03-15',
      dueDate: '2026-04-15',
      netCents: 11_000,
      vatCents: 2_420,
      vatRateBp: 2200,
      grossCents: 13_420,
      currency: 'EUR',
      supplier: { name: 'Aruba S.p.A.', vatNumber: '04552920482' },
      customer: { name: 'Federico Rossi', vatNumber: null },
    });
  });

  it('non riporta l’aliquota se ce n’è più d’una, e ricava il totale se manca', () => {
    const mixed = FATTURA.replace(
      '<AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>10.00',
      '<AliquotaIVA>4.00</AliquotaIVA><ImponibileImporto>10.00',
    ).replace(/<ImportoTotaleDocumento>.*<\/ImportoTotaleDocumento>/, '');
    const parsed = parseFatturaPA(mixed);
    expect(parsed?.vatRateBp).toBeNull();
    expect(parsed?.grossCents).toBe(13_420);
  });

  it('non scambia per fattura un XML qualunque', () => {
    expect(parseFatturaPA('<?xml version="1.0"?><note>ciao</note>')).toBeNull();
  });
});

/**
 * Byte di un testo ASCII, e Base64 di dei byte.
 *
 * Senza `TextEncoder` e `btoa`, per la stessa ragione di `extraction.ts`:
 * `shared` non ha i tipi di nessun ambiente, nemmeno nei test.
 */
function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    const left = bytes.length - i;
    out += alphabet[(n >> 18) & 63] ?? '';
    out += alphabet[(n >> 12) & 63] ?? '';
    out += left > 1 ? (alphabet[(n >> 6) & 63] ?? '') : '=';
    out += left > 2 ? (alphabet[n & 63] ?? '') : '=';
  }
  return out;
}

/** Una busta CMS minima, come la costruirebbe un firmatario: BER a lunghezza indefinita. */
function envelope(xml: string, chunk: number | null, base64 = false): Uint8Array {
  const content = ascii(xml);
  const tlv = (tag: number, body: number[]) => {
    const n = body.length;
    const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, (n >> 8) & 0xff, n & 0xff];
    return [tag, ...length, ...body];
  };
  const indefinite = (tag: number, body: number[]) => [tag, 0x80, ...body, 0, 0];

  let octetString: number[];
  if (chunk === null) {
    octetString = tlv(0x04, [...content]);
  } else {
    // Il caso che rompe la scorciatoia: il contenuto in blocchi, ciascuno col
    // suo intestatario binario in mezzo all'XML.
    const pieces: number[] = [];
    for (let i = 0; i < content.length; i += chunk) {
      pieces.push(...tlv(0x04, [...content.subarray(i, i + chunk)]));
    }
    octetString = indefinite(0x24, pieces);
  }
  const oidData = tlv(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]);
  const encapContent = indefinite(0x30, [...oidData, ...indefinite(0xa0, octetString)]);
  const signedData = indefinite(0x30, [...tlv(0x02, [1]), ...tlv(0x31, []), ...encapContent]);
  const bytes = Uint8Array.from(indefinite(0x30, [...oidData, ...indefinite(0xa0, signedData)]));
  if (!base64) return bytes;
  return ascii(toBase64(bytes).replace(/(.{64})/g, '$1\n'));
}

describe('fattura firmata (.p7m)', () => {
  it('estrae l’XML da una busta in un pezzo solo', () => {
    expect(extractXmlFromP7m(envelope(FATTURA, null))).toBe(FATTURA);
  });

  it('ricuce l’XML spezzato in blocchi', () => {
    const xml = extractXmlFromP7m(envelope(FATTURA, 100));
    expect(xml).toBe(FATTURA);
    expect(parseFatturaPA(xml ?? '')?.number).toBe('FPR 12/26 & bis');
  });

  it('legge anche la busta in Base64', () => {
    expect(extractXmlFromP7m(envelope(FATTURA, 100, true))).toBe(FATTURA);
  });

  it('restituisce null su un file che non è una busta', () => {
    expect(extractXmlFromP7m(ascii('%PDF-1.4 niente'))).toBeNull();
    expect(extractXmlFromP7m(Uint8Array.from([0x30, 0x82, 0xff]))).toBeNull();
  });
});

describe('pezzi di testo', () => {
  it('riconosce le date nelle forme italiane, e scarta quelle impossibili', () => {
    expect(datesIn('del 15/03/2026, scade il 30.4.26 o il 2026-05-01')).toEqual([
      '2026-03-15',
      '2026-04-30',
      '2026-05-01',
    ]);
    expect(datesIn('emessa il 5 marzo 2026')).toEqual(['2026-03-05']);
    expect(datesIn('31/02/2026')).toEqual([]);
  });

  it('prende per importi solo i numeri con i centesimi', () => {
    expect(amountsIn('Totale € 1.234,56')).toEqual([123_456]);
    expect(amountsIn('Fattura n. 2026 CAP 20121 totale 99,90')).toEqual([9_990]);
    expect(amountsIn('Total 1,234.56 USD')).toEqual([123_456]);
  });

  it('tiene solo le partite IVA con la cifra di controllo giusta', () => {
    expect(vatNumbersIn('P.IVA IT04552920482 tel. 05750505050 cod. 12345678901')).toEqual([
      '04552920482',
    ]);
  });
});

describe('testo di un PDF', () => {
  const invoice = `Aruba S.p.A.
Via San Clemente 53 - 24036 Ponte San Pietro (BG)
P.IVA 04552920482
Spett.le Federico Rossi
FATTURA N. A26-000123 del 15/03/2026
Descrizione Importo
Rinnovo dominio example.it 9,99
Hosting Linux Easy 90,01
Imponibile 100,00
IVA 22% 22,00
Totale documento € 122,00
Data scadenza: 30/04/2026`;

  it('trova numero, date e importi dalle etichette', () => {
    expect(extractFromText(invoice)).toMatchObject({
      source: 'text',
      kind: 'INVOICE_PASSIVE',
      number: 'A26-000123',
      issueDate: '2026-03-15',
      dueDate: '2026-04-30',
      netCents: 10_000,
      vatRateBp: 2200,
      vatCents: 2_200,
      grossCents: 12_200,
      currency: 'EUR',
      vatNumbers: ['04552920482'],
    });
  });

  it('non prende la scadenza per la data del documento', () => {
    const text =
      'Fattura numero 7\nData scadenza 30/04/2026\nData fattura 01/04/2026\nTotale 10,00';
    const parsed = extractFromText(text);
    expect(parsed.issueDate).toBe('2026-04-01');
    expect(parsed.dueDate).toBe('2026-04-30');
  });

  it('legge un valore scritto sulla riga sotto l’etichetta', () => {
    const parsed = extractFromText('Ricevuta\nTotale da pagare\n€ 45,00');
    expect(parsed.kind).toBe('RECEIPT');
    expect(parsed.grossCents).toBe(4_500);
  });

  it('riconosce un F24 e il suo saldo', () => {
    const f24 = 'MODELLO F24\nSEZIONE INPS\nSALDO FINALE EURO 1.536,40\nData 16/06/2026';
    expect(extractFromText(f24)).toMatchObject({
      kind: 'F24',
      grossCents: 153_640,
      issueDate: '2026-06-16',
    });
  });

  it('su un testo che non dice niente non inventa niente', () => {
    expect(extractFromText('Gentile cliente, grazie per la collaborazione.')).toMatchObject({
      kind: null,
      number: null,
      issueDate: null,
      grossCents: null,
    });
  });
});

describe('controparte', () => {
  const known = {
    vendors: [{ id: 'v-aruba', name: 'Aruba', vatNumber: '04552920482' }],
    clients: [{ id: 'c-acme', name: 'Acme Industrie', vatNumber: '00743110157' }],
  };

  it('fattura elettronica: cedente fornitore vuol dire ricevuta', () => {
    const parsed = parseFatturaPA(FATTURA);
    expect(parsed && resolveCounterparty(parsed, known)).toEqual({
      kind: 'INVOICE_PASSIVE',
      clientId: null,
      vendorId: 'v-aruba',
    });
  });

  it('fattura elettronica: cessionario cliente vuol dire emessa', () => {
    const issued = FATTURA.replace('04552920482', '01234567897').replace(
      '<CodiceFiscale>',
      '<IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>00743110157</IdCodice></IdFiscaleIVA><CodiceFiscale>',
    );
    const parsed = parseFatturaPA(issued);
    expect(parsed && resolveCounterparty(parsed, known)).toEqual({
      kind: 'INVOICE_ACTIVE',
      clientId: 'c-acme',
      vendorId: null,
    });
  });

  it('testo: prima la partita IVA, poi il nome', () => {
    const byVat = extractFromText('Fattura n. 1 del 01/01/2026\nP.IVA 04552920482');
    expect(resolveCounterparty(byVat, known).vendorId).toBe('v-aruba');

    const text = 'Fattura n. 9 del 01/02/2026 ad ACME INDUSTRIE srl';
    expect(resolveCounterparty(extractFromText(text), known, text)).toEqual({
      kind: 'INVOICE_ACTIVE',
      clientId: 'c-acme',
      vendorId: null,
    });
  });

  it('non decide niente se nessuna parte è in anagrafica', () => {
    expect(resolveCounterparty(extractFromText('Fattura n. 3'), known, 'Fattura n. 3')).toEqual({
      kind: null,
      clientId: null,
      vendorId: null,
    });
  });
});
