import {
  type ExtractedDocument,
  extractFromText,
  extractXmlFromP7m,
  parseFatturaPA,
  // Da qui e non dall'indice: l'indice arriva al login con tutto ciò che
  // riesporta, e queste regole servono a una pagina sola.
} from '@easygest/shared/extraction';

import { mimeTypeOf } from './documents';

/**
 * Leggere un file per compilare il documento: la metà che vive nel browser.
 *
 * Le regole stanno in `extraction.ts` di `shared`; qui c'è solo come si ottiene
 * il testo da dare loro, e ognuna delle tre strade costa un ordine di
 * grandezza più della precedente:
 *
 * - un XML si legge e basta;
 * - un PDF con testo passa da pdf.js, che pesa un mega e si scarica la prima
 *   volta che serve;
 * - una scansione passa dall'OCR, che scarica Tesseract e il modello
 *   dell'italiano — qualche mega, una volta — e poi impiega secondi, non
 *   millisecondi.
 *
 * Tutto succede sul computer di chi carica. Il file non va da nessuna parte
 * che non sia il bucket: dai CDN arrivano i programmi e il modello, non partono
 * i documenti.
 */

export type ExtractionStep = 'reading' | 'ocr';

/** Oltre, la terza pagina di un PDF è quasi sempre condizioni generali. */
const PDF_PAGES = 3;
/** Sotto questa soglia un PDF «con testo» è in realtà una scansione con un timbro. */
const MIN_TEXT_LENGTH = 40;

export async function extractDocument(
  file: File,
  onStep: (step: ExtractionStep) => void = () => undefined,
): Promise<{ extracted: ExtractedDocument; text: string } | null> {
  const mimeType = mimeTypeOf(file);
  onStep('reading');

  switch (mimeType) {
    case 'application/xml':
    case 'text/xml': {
      const xml = await file.text();
      const extracted = parseFatturaPA(xml);
      return extracted === null ? null : { extracted, text: '' };
    }
    case 'application/pkcs7-mime': {
      const xml = extractXmlFromP7m(new Uint8Array(await file.arrayBuffer()));
      const extracted = xml === null ? null : parseFatturaPA(xml);
      return extracted === null ? null : { extracted, text: '' };
    }
    case 'application/pdf': {
      const pdf = await readPdf(file);
      if (pdf.text.replace(/\s/g, '').length >= MIN_TEXT_LENGTH) {
        return { extracted: extractFromText(pdf.text, 'text'), text: pdf.text };
      }
      onStep('ocr');
      const text = await ocr(await pdf.renderFirstPages());
      return { extracted: extractFromText(text, 'ocr'), text };
    }
    case 'image/jpeg':
    case 'image/png':
    case 'image/webp': {
      onStep('ocr');
      const text = await ocr([file]);
      return { extracted: extractFromText(text, 'ocr'), text };
    }
    case null:
      return null;
  }
}

/** Un frammento di testo come lo restituisce pdf.js. */
export interface TextItem {
  str: string;
  /** La matrice di trasformazione; la sesta voce è la quota verticale. */
  transform: unknown[];
  hasEOL: boolean;
}

/**
 * Da frammenti a righe.
 *
 * pdf.js non restituisce righe ma pezzi di testo, spesso una cella di tabella
 * ciascuno, e non sempre segna la fine della riga. Si va a capo quando il
 * frammento lo dice **o** quando cambia la quota verticale: senza la seconda
 * regola, «Totale documento» e «€ 122,00» — due celle della stessa riga —
 * potrebbero finire su due righe o, peggio, attaccati alla riga dopo, e le
 * regole che cercano il valore accanto all'etichetta non lo troverebbero.
 */
export function linesFromTextItems(items: readonly (TextItem | object)[]): string[] {
  const lines: string[] = [];
  let current = '';
  let lastY: number | null = null;
  for (const item of items) {
    if (!('str' in item)) continue;
    const y = Number(item.transform[5] ?? 0);
    if (lastY !== null && Math.abs(y - lastY) > 2 && current.trim() !== '') {
      lines.push(current.trim());
      current = '';
    }
    if (item.str !== '') {
      current += (current === '' || current.endsWith(' ') ? '' : ' ') + item.str;
    }
    lastY = y;
    if (item.hasEOL && current.trim() !== '') {
      lines.push(current.trim());
      current = '';
      lastY = null;
    }
  }
  if (current.trim() !== '') lines.push(current.trim());
  return lines;
}

async function readPdf(file: File) {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    .promise;
  const pages = Math.min(document.numPages, PDF_PAGES);

  const lines: string[] = [];
  for (let number = 1; number <= pages; number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    lines.push(...linesFromTextItems(content.items));
  }

  return {
    text: lines.join('\n'),
    /** Le pagine come immagini, per l'OCR di una scansione. */
    async renderFirstPages(): Promise<HTMLCanvasElement[]> {
      const canvases: HTMLCanvasElement[] = [];
      // Una pagina sola per l'OCR: su una scansione di tre pagine vuol dire
      // un terzo dell'attesa, e i dati di una fattura stanno in testa.
      const page = await document.getPage(1);
      // Due volte la risoluzione di schermo: sotto, Tesseract confonde le
      // virgole dei centesimi con i punti; sopra, rallenta senza leggere meglio.
      const viewport = page.getViewport({ scale: 2 });
      const canvas = window.document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvas, viewport }).promise;
      canvases.push(canvas);
      return canvases;
    },
  };
}

async function ocr(images: (HTMLCanvasElement | File)[]): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  // Il modello dell'italiano: legge «€», gli accenti e le parole delle
  // etichette meglio di quello inglese, che scambia «Totale» per «Tota1e».
  const worker = await createWorker('ita');
  try {
    const texts: string[] = [];
    for (const image of images) {
      const { data } = await worker.recognize(image);
      texts.push(data.text);
    }
    return texts.join('\n');
  } finally {
    await worker.terminate();
  }
}
