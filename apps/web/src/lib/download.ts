/**
 * Salvare un testo come file, dal browser.
 *
 * È la metà che `csv.ts` promette e non fa: là la serializzazione, pura e
 * provata; qui il `Blob`, l'oggetto URL e l'ancora finta, cioè le tre cose che
 * esistono solo dentro una scheda aperta.
 *
 * **Non ha test, ed è dichiarato.** La suite gira in `environment: 'node'`:
 * qui non c'è `Blob`, non c'è `URL.createObjectURL`, non c'è `document`. Un
 * test con dei finti verificherebbe di aver chiamato dei finti, cioè proprio
 * il contrario di quello che serve sapere — se il file arriva sul disco con il
 * nome giusto lo dice solo un browser. È il motivo per cui tutta la logica che
 * si può sbagliare sta in `ledgerToCsv`, dove è provabile.
 */

/**
 * Il tipo MIME è fisso perché c'è un chiamante solo.
 *
 * `charset=utf-8` accompagna il BOM che `toCsv` mette in testa: sono due
 * dichiarazioni della stessa cosa a due livelli diversi, e su Windows è il BOM
 * quello che Excel guarda davvero.
 */
const CSV_TYPE = 'text/csv;charset=utf-8';

export function downloadCsv(fileName: string, text: string): void {
  /**
   * Un `Blob`, e **non** un `data:` URL.
   *
   * Due motivi, entrambi silenziosi. Il BOM sopravvive come `EF BB BF` invece
   * di passare per una codifica in base64 o percentuale che può mangiarselo, e
   * su cinquemila righe un `data:` supererebbe i limiti di lunghezza dell'URL
   * di alcuni browser — che non danno errore, semplicemente non scaricano.
   */
  const url = URL.createObjectURL(new Blob([text], { type: CSV_TYPE }));

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;

  // L'ancora va appesa al documento prima del click: Firefox ignora un click
  // su un nodo staccato dall'albero, e non lo segnala in nessun modo.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  /**
   * La revoca aspetta un giro di event loop.
   *
   * Revocare subito annulla il download che è appena partito; non revocare mai
   * tiene l'intera stringa in memoria finché vive la scheda. Il `setTimeout` a
   * zero è il punto in mezzo: il browser ha già preso in carico l'URL.
   */
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
