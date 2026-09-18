/**
 * Stampare la pagina dal browser, con un nome sensato per il PDF.
 *
 * Gemello di `download.ts`: là il `Blob` e l'ancora finta, qui `window.print()`
 * e il titolo del documento, cioè cose che esistono solo dentro una scheda
 * aperta.
 *
 * **Non ha test, ed è dichiarato.** La suite gira in `environment: 'node'`: non
 * c'è `window`, non c'è `document`, non c'è impaginazione. Un test con dei
 * finti verificherebbe di aver chiamato dei finti — se il dialogo propone il
 * nome giusto lo dice solo un browser, e qui solo Chrome è stato verificato.
 * Per la stessa ragione l'intero blocco `@media print` di `index.css` non ha
 * prove: ciò che si può sbagliare in silenzio sta altrove, dove è provabile.
 *
 * **Limite noto**: un `Ctrl+P` diretto non passa di qui, e il file proposto
 * resta `EasyGest.pdf`. È una ragione in più perché il bottone esista, oltre
 * alla scopribilità.
 */

/**
 * Stampa la pagina proponendo `title` come nome del file.
 *
 * Chrome compone il nome del PDF dal `document.title`, che è fisso a
 * `EasyGest` in `index.html`. Tre trabocchetti, tutti e tre già pagati qui:
 *
 * - **il titolo si scambia prima di `print()`, non dentro un `beforeprint`**:
 *   quando Chrome legga il titolo per comporre l'anteprima non è documentato, e
 *   prima della chiamata è l'unico istante in cui si è certi che sia già quello
 *   giusto;
 * - **si rimette con `afterprint`, non dopo il ritorno di `print()`**: su
 *   Chrome `print()` blocca finché il dialogo è aperto, ma non ovunque, e dove
 *   non blocca il titolo tornerebbe indietro prima che serva;
 * - **l'ascoltatore si toglie da sé**, o una seconda stampa ne lascerebbe due.
 */
export function printWithTitle(title: string): void {
  const previous = document.title;
  document.title = title;

  window.addEventListener(
    'afterprint',
    () => {
      document.title = previous;
    },
    { once: true },
  );

  window.print();
}
