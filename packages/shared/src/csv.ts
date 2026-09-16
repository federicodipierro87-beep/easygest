import { centsToDecimalString, type Cents } from './money';

/**
 * Serializzazione CSV per Excel in italiano.
 *
 * Non è «un CSV generico»: è il formato che Excel con impostazioni italiane
 * apre con un doppio clic senza chiedere niente. Ogni scelta qui sotto esiste
 * per quel bersaglio, e tolta una il file smette di essere usabile — non in
 * modo vistoso, ma in modo silenzioso, che è peggio.
 *
 * Sta in `shared` e non in `apps/web` perché è logica pura e va provata come
 * tale: la parte che tocca il DOM — `Blob`, `createObjectURL`, l'ancora
 * staccata — vive da sola in `apps/web/src/lib/download.ts`, dove non c'è
 * niente da provare se non il browser.
 */

/**
 * Il punto e virgola e la virgola decimale sono **una** decisione, non due.
 *
 * Excel in locale italiano legge la virgola come separatore decimale. Usarla
 * anche fra i campi spezzerebbe ogni importo su due colonne: `12,34`
 * diventerebbe `12` e `34`. Dato che gli importi devono restare sommabili — è
 * il motivo per cui si esporta — il separatore di campo non può che essere il
 * punto e virgola.
 */
export const CSV_DELIMITER = ';';

/**
 * Tre caratteri che decidono se il file è leggibile.
 *
 * Senza BOM, Excel su Windows apre in ANSI e «società» diventa «societÃ ».
 * Nessun errore, nessun avviso: solo un foglio pieno di nomi di fornitori
 * sbagliati che sembra un difetto dei dati e non dell'esportazione.
 */
export const CSV_BOM = '\uFEFF';

/**
 * I caratteri che trasformano un campo di testo in una formula.
 *
 * Aprire un CSV in Excel valuta ogni cella che comincia per `=`, `+`, `-` o
 * `@`: un fornitore che si chiamasse `=cmd|'/c calc'!A1` diventerebbe un
 * comando. Tabulazione e ritorno a capo ci stanno perché Excel li scarta
 * all'inizio della cella e valuta ciò che segue, aggirando un controllo che
 * guardasse solo il primo carattere.
 */
const FORMULA_STARTERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** I caratteri che obbligano a mettere il campo fra virgolette. */
const MUST_QUOTE = [CSV_DELIMITER, '"', '\r', '\n'];

function quote(field: string): string {
  return `"${field.replaceAll('"', '""')}"`;
}

/**
 * Un campo di testo, reso innocuo.
 *
 * Il prefisso è un apostrofo: Excel lo consuma mostrando il testo così com'è,
 * e il valore resta leggibile invece di sparire dietro a `#NOME?`. Il campo
 * viene anche quotato, perché altrimenti l'apostrofo sarebbe l'unica difesa e
 * un `;` nel nome continuerebbe a spezzare la riga.
 *
 * **Questa funzione non tocca mai gli importi.** Vedi `csvAmount`.
 */
export function csvText(value: string | null | undefined): string {
  if (value == null || value === '') return '';

  const dangerous = FORMULA_STARTERS.has(value[0] ?? '');
  const body = dangerous ? `'${value}` : value;

  return dangerous || MUST_QUOTE.some((char) => body.includes(char)) ? quote(body) : body;
}

/**
 * Un importo in centesimi, come Excel lo sa sommare.
 *
 * Parte dagli interi e non da un numero in virgola mobile — la stessa
 * trasformazione di `euroFromCents` — così `12,34` non diventa mai
 * `12,339999999`. Senza simbolo di valuta e senza separatore di migliaia:
 * `1.234,00` con il punto lo leggerebbe come testo, e la colonna smetterebbe
 * di essere sommabile.
 *
 * **Non passa dal sanitizzatore di `csvText`, ed è proprio questo il punto.**
 * Un negativo comincia per `-`, che è uno dei caratteri da cui una formula può
 * partire: passandolo di lì, `-42,00` diventerebbe `'-42,00`, cioè testo, e la
 * somma della colonna sbaglierebbe di quanto vale ogni rimborso. Testo e
 * importi hanno due percorsi separati per questa ragione sola, e i due percorsi
 * non vanno uniti «per pulizia».
 */
export function csvAmount(cents: Cents): string {
  return centsToDecimalString(cents).replace('.', ',');
}

/**
 * Una data, lasciata com'è.
 *
 * `YYYY-MM-DD` è l'unico formato che Excel riconosce come data qualunque siano
 * le impostazioni locali, e che ordinato come testo dà comunque l'ordine
 * cronologico. Un `15/03/2027` sarebbe più familiare da leggere e
 * ambiguamente americano da ordinare.
 */
export function csvDate(iso: string | null | undefined): string {
  return iso ?? '';
}

/**
 * Le righe in un testo.
 *
 * Terminatori `\r\n` perché è quello che dice RFC 4180 ed è quello che Excel
 * si aspetta; il BOM in testa una volta sola. Le celle arrivano già
 * serializzate: `toCsv` non sa se una colonna è testo o denaro, e non deve
 * saperlo — indovinarlo è esattamente il modo in cui un importo negativo
 * finirebbe apostrofato.
 */
export function toCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [headers.join(CSV_DELIMITER), ...rows.map((row) => row.join(CSV_DELIMITER))];
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}
