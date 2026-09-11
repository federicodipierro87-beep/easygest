/**
 * Dal testo all'HTML, in venti righe.
 *
 * Niente MJML e niente React Email: sono strumenti per newsletter con colonne,
 * immagini e pulsanti, mentre qui i messaggi sono quattro e fatti di righe di
 * testo. La versione HTML esiste perché senza, alcuni client mostrano tutto
 * appiccicato su una riga sola; non perché ci sia una grafica da rendere.
 */

/**
 * Rende innocuo il testo che finisce dentro i tag.
 *
 * I nomi delle spese li scrive l'utente: una spesa chiamata `<b>Hosting` non
 * deve poter riscrivere il resto del messaggio. Non è una difesa contro un
 * attacco — è l'utente stesso il solo destinatario — ma contro un'email che
 * arriva sfigurata senza che si capisca perché.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Trasforma in link gli URL che il testo contiene già, senza inventarne altri. */
function linkify(line: string): string {
  return line.replace(
    /https?:\/\/\S+/g,
    (url) => `<a href="${url}" style="color:#2563eb">${url}</a>`,
  );
}

/**
 * Stili in linea e non in un `<style>`: Gmail sfronda il foglio di stile nella
 * vista conversazione, e il risultato sarebbe un messaggio che appare corretto
 * in prova e sformattato in casella.
 */
export function renderHtml(text: string): string {
  const body = text
    .split('\n')
    .map((line) =>
      line === '' ? '<br />' : `<p style="margin:0 0 8px">${linkify(escapeHtml(line))}</p>`,
    )
    .join('\n');

  return [
    '<!doctype html>',
    '<html lang="it"><body style="margin:0;padding:24px;background:#f8fafc">',
    '<div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;border-radius:12px;font:14px/1.6 system-ui,sans-serif;color:#0f172a">',
    body,
    '</div></body></html>',
  ].join('\n');
}
