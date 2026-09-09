import { describe, expect, it } from 'vitest';

import {
  emailFieldSchema,
  hasValidVatChecksum,
  isValidTaxCode,
  normalizeFiscalId,
  urlSchema,
  vatNumberSchema,
} from './fiscal';

describe('cifra di controllo della partita IVA', () => {
  it('accetta partite IVA ben formate', () => {
    // L'undicesima cifra è calcolata dalle altre dieci: questi due valori la
    // rispettano, ed è l'unico modo onesto di provare l'algoritmo.
    expect(hasValidVatChecksum('00743110157')).toBe(true);
    expect(hasValidVatChecksum('12345678903')).toBe(true);
  });

  it('rifiuta una cifra di controllo sbagliata', () => {
    expect(hasValidVatChecksum('00743110158')).toBe(false);
  });

  it('si accorge di due cifre invertite', () => {
    // È l'errore che si fa ricopiando a mano, ed è la ragione per cui questo
    // controllo esiste: la somma delle cifre non cambia, ma i pesi alternati sì.
    expect(hasValidVatChecksum('00473110157')).toBe(false);
  });

  it('rifiuta tutto ciò che non siano undici cifre', () => {
    expect(hasValidVatChecksum('0074311015')).toBe(false);
    expect(hasValidVatChecksum('007431101577')).toBe(false);
    expect(hasValidVatChecksum('IT007431101')).toBe(false);
  });
});

describe('normalizzazione degli identificativi', () => {
  it('toglie la punteggiatura con cui vengono scritti', () => {
    // Copiata da una fattura, da un sito e da una email, la stessa partita IVA
    // ha tre forme diverse: archiviandole così una ricerca non le troverebbe.
    expect(normalizeFiscalId(' 007.4311.0157 ')).toBe('00743110157');
    expect(normalizeFiscalId('rssmra85t10a562s')).toBe('RSSMRA85T10A562S');
  });

  it('toglie il prefisso IT, che è la stessa partita IVA in formato VIES', () => {
    const result = vatNumberSchema.safeParse('IT 00743110157');
    expect(result.success && result.data).toBe('00743110157');
  });
});

describe('codice fiscale', () => {
  it('accetta un codice di persona fisica', () => {
    expect(isValidTaxCode('RSSMRA85T10A562S')).toBe(true);
  });

  it('accetta l’omocodia', () => {
    // Quando due persone otterrebbero lo stesso codice, l'Agenzia sostituisce
    // alcune cifre con lettere secondo una tabella fissa. Un controllo che
    // pretendesse solo numeri rifiuterebbe codici veri.
    expect(isValidTaxCode('RSSMRA85T10A56VS')).toBe(true);
  });

  it('accetta un codice di azienda solo se la cifra di controllo torna', () => {
    // Per un'azienda il codice fiscale sono le stesse undici cifre della
    // partita IVA, quindi vale la stessa verifica.
    expect(isValidTaxCode('00743110157')).toBe(true);
    expect(isValidTaxCode('00743110158')).toBe(false);
  });

  it('rifiuta una lettera di mese inesistente', () => {
    // I mesi sono dodici lettere scelte, e la F non è fra quelle.
    expect(isValidTaxCode('RSSMRA85F10A562S')).toBe(false);
  });
});

describe('campi facoltativi', () => {
  it('trasforma il vuoto in null invece di archiviarlo', () => {
    // Un form manda "" per ogni casella non toccata. Se finisse nel database,
    // il campo risulterebbe compilato ma vuoto e nessun controllo su «manca la
    // PEC» funzionerebbe più.
    expect(emailFieldSchema.parse('')).toBe(null);
    expect(emailFieldSchema.parse('   ')).toBe(null);
    expect(emailFieldSchema.parse(null)).toBe(null);
  });

  it('valida davvero quando un valore c’è', () => {
    expect(emailFieldSchema.parse('Info@Acme.IT')).toBe('info@acme.it');
    expect(emailFieldSchema.safeParse('non-una-email').success).toBe(false);
  });
});

describe('indirizzi web', () => {
  it('aggiunge lo schema a chi scrive solo il dominio', () => {
    // Nessuno digita «https://»: rifiutare «aruba.it» sarebbe pignoleria
    // scaricata addosso a chi compila.
    expect(urlSchema.parse('Aruba.it')).toBe('https://aruba.it/');
  });

  it('rifiuta i protocolli che non sono http', () => {
    // Questo valore diventa l'href di un collegamento nella pagina: un
    // `javascript:` archiviato qui verrebbe eseguito da chi ci clicca sopra.
    expect(urlSchema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(urlSchema.safeParse('data:text/html,<script>x</script>').success).toBe(false);
    expect(urlSchema.safeParse('ftp://archivio.example').success).toBe(false);
  });
});
