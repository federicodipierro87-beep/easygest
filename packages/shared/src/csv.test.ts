import { describe, expect, it } from 'vitest';

import { CSV_BOM, csvAmount, csvDate, csvText, toCsv } from './csv';

/**
 * Le regole del CSV per Excel italiano.
 *
 * Non si prova che «il CSV sia valido»: si provano le quattro cose che, se
 * cedono, non danno errore da nessuna parte e si scoprono solo aprendo il file
 * — il quoting, l'apostrofo davanti alle formule, l'**assenza** di apostrofo
 * davanti ai negativi e i terminatori di riga.
 */

describe('campi di testo', () => {
  it('lascia stare quello che non ha bisogno di niente', () => {
    expect(csvText('Hosting Hetzner')).toBe('Hosting Hetzner');
  });

  it('vuoto e nullo valgono la stessa cella vuota', () => {
    // Nel CSV non c'è modo di distinguere «campo assente» da «campo vuoto», e
    // fingere che ci sia — scrivendo `null` — riempirebbe una colonna di
    // quattro lettere che Excel mostrerebbe come testo.
    expect(csvText(null)).toBe('');
    expect(csvText(undefined)).toBe('');
    expect(csvText('')).toBe('');
  });

  it('quota il campo che contiene il separatore', () => {
    // Senza, la riga guadagnerebbe una colonna e tutte quelle dopo
    // slitterebbero di uno.
    expect(csvText('Rossi; Bianchi e Verdi')).toBe('"Rossi; Bianchi e Verdi"');
  });

  it('raddoppia le virgolette e quota', () => {
    expect(csvText('Servizio "base"')).toBe('"Servizio ""base"""');
  });

  it('quota il campo che contiene un a capo', () => {
    // Un `\n` non quotato spezza la riga in due, e la seconda metà diventa un
    // record con il numero sbagliato di colonne.
    expect(csvText('Prima riga\nSeconda riga')).toBe('"Prima riga\nSeconda riga"');
  });
});

describe('difesa dalle formule', () => {
  it('apostrofa e quota quello che comincia per uguale', () => {
    expect(csvText('=SOMMA(A1)')).toBe(`"'=SOMMA(A1)"`);
  });

  it('copre anche piu, chiocciola e i bianchi che Excel scarta', () => {
    // Tabulazione e ritorno a capo esistono nell'elenco perché Excel li salta
    // e valuta ciò che segue: un controllo sul solo primo carattere visibile
    // li lascerebbe passare.
    expect(csvText('+1-2')).toBe(`"'+1-2"`);
    expect(csvText('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvText('\t=SOMMA(A1)')).toBe(`"'\t=SOMMA(A1)"`);
  });

  it('un nome che comincia per trattino resta leggibile', () => {
    // L'apostrofo Excel lo consuma: in cella si legge «-Studio Rossi», non
    // «'-Studio Rossi» e nemmeno `#NOME?`.
    expect(csvText('-Studio Rossi')).toBe(`"'-Studio Rossi"`);
  });
});

describe('importi', () => {
  it('vanno in centesimi con la virgola decimale', () => {
    expect(csvAmount(1234)).toBe('12,34');
    expect(csvAmount(0)).toBe('0,00');
    expect(csvAmount(5)).toBe('0,05');
  });

  it('senza separatore di migliaia', () => {
    // `1.234,00` con il punto Excel lo legge come testo, e la colonna smette
    // di essere sommabile — che è l'unico motivo per cui si esporta.
    expect(csvAmount(123_400)).toBe('1234,00');
  });

  it('un negativo non viene mai apostrofato', () => {
    // **La regressione che conta.** `-42,00` comincia per `-`, che è uno dei
    // caratteri da cui parte una formula: se gli importi passassero dal
    // sanitizzatore di `csvText` diventerebbero testo e la somma della colonna
    // sbaglierebbe di quanto vale ogni rimborso, in silenzio.
    expect(csvAmount(-4200)).toBe('-42,00');
    expect(csvAmount(-4200)).not.toContain("'");
  });
});

describe('date', () => {
  it('restano in ISO', () => {
    expect(csvDate('2027-03-15')).toBe('2027-03-15');
  });

  it('il nullo è una cella vuota', () => {
    expect(csvDate(null)).toBe('');
    expect(csvDate(undefined)).toBe('');
  });
});

describe('il file intero', () => {
  it('comincia con il BOM e termina le righe con CRLF', () => {
    const text = toCsv(['spesa', 'totale'], [['Hosting', '24,40']]);

    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text).toBe(`${CSV_BOM}spesa;totale\r\nHosting;24,40\r\n`);
  });

  it("un file senza righe ha comunque l'intestazione", () => {
    // Un file vuoto in Excel è una finestra di errore. Con la sola
    // intestazione si apre, si vede che non c'è niente, e si capisce che il
    // filtro era troppo stretto.
    const text = toCsv(['spesa', 'totale'], []);

    expect(text).toBe(`${CSV_BOM}spesa;totale\r\n`);
  });
});
