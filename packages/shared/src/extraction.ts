import { hasValidVatChecksum } from './fiscal';
import { parseAmountToCents } from './money';
import type { DocumentKind } from './documents';

/**
 * Dal contenuto di un file ai campi di un documento.
 *
 * Tutto qui è puro — stringhe e byte in ingresso, un oggetto in uscita — e
 * per questo sta in `shared` e non nel browser: le regole si provano in Node
 * su testi veri, mentre pdf.js e Tesseract, che producono quei testi, restano
 * nel frontend dove hanno senso.
 *
 * Le fonti non valgono tutte uguale, e il risultato dice da quale viene:
 *
 * - **la fattura elettronica** è un XML con uno schema pubblico. I campi si
 *   leggono, non si indovinano: numero, data, importi e partite IVA sono
 *   esatti;
 * - **il testo di un PDF** e **quello dell'OCR** si interpretano con regole
 *   sulle etichette («Totale documento», «Scadenza»). Sbagliano, e l'interfaccia
 *   lo deve dire: propongono, non decidono.
 *
 * Nessuna regola scrive un campo che non ha trovato. Un campo vuoto è una
 * domanda per chi compila; uno sbagliato con aria sicura è un errore che
 * finisce nell'archivio.
 */

export type ExtractionSource = 'fatturapa' | 'text' | 'ocr';

export interface ExtractedParty {
  name: string | null;
  vatNumber: string | null;
}

export interface ExtractedDocument {
  source: ExtractionSource;
  /** Solo quando il contenuto lo dice: «fattura», «F24», «ricevuta». */
  kind: DocumentKind | null;
  number: string | null;
  issueDate: string | null;
  dueDate: string | null;
  netCents: number | null;
  vatRateBp: number | null;
  vatCents: number | null;
  grossCents: number | null;
  currency: string | null;
  /** Chi ha emesso il documento, se si sa. */
  supplier: ExtractedParty | null;
  /** A chi è intestato, se si sa. */
  customer: ExtractedParty | null;
  /** Partite IVA trovate nel testo senza sapere di chi sono. */
  vatNumbers: string[];
}

const empty = (source: ExtractionSource): ExtractedDocument => ({
  source,
  kind: null,
  number: null,
  issueDate: null,
  dueDate: null,
  netCents: null,
  vatRateBp: null,
  vatCents: null,
  grossCents: null,
  currency: null,
  supplier: null,
  customer: null,
  vatNumbers: [],
});

// ─────────────────────────────────────────────────────────────────────────────
// Fattura elettronica
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il contenuto di un tag, con o senza prefisso di namespace.
 *
 * Non un parser XML: lo schema della FatturaPA è fisso e poco profondo, e
 * `DOMParser` non esiste in Node, dove girano i test. I tag interni di una
 * fattura sono senza prefisso quasi sempre, ma `<p:FatturaElettronica>` in
 * testa è la norma, e qualche gestionale prefissa tutto.
 */
function blocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`,
    'g',
  );
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? '');
}

function first(xml: string | null, ...path: string[]): string | null {
  let current: string | null = xml;
  for (const tag of path) {
    if (current === null) return null;
    current = blocks(current, tag)[0] ?? null;
  }
  return current === null ? null : decodeEntities(current).trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** `1234.50` → `123450`. Nella FatturaPA il separatore è sempre il punto. */
function xmlCents(value: string | null): number | null {
  if (value === null || !/^-?\d+(\.\d+)?$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

function party(xml: string | null): ExtractedParty | null {
  if (xml === null) return null;
  const vat = first(xml, 'IdFiscaleIVA', 'IdCodice');
  const denomination = first(xml, 'Anagrafica', 'Denominazione');
  const person = [first(xml, 'Anagrafica', 'Nome'), first(xml, 'Anagrafica', 'Cognome')]
    .filter((part) => part !== null)
    .join(' ');
  return {
    name: denomination ?? (person === '' ? null : person),
    vatNumber: vat === null ? null : normalizeVat(vat),
  };
}

export function isFatturaPA(xml: string): boolean {
  return /<(?:[\w.-]+:)?FatturaElettronica[\s>]/.test(xml);
}

/**
 * I campi di una fattura elettronica.
 *
 * Di un lotto — più fatture nello stesso file — si legge la prima: è un caso
 * raro per un professionista, e un documento dell'archivio è un file.
 *
 * Imponibile e IVA sono la somma dei riepiloghi, uno per aliquota; l'aliquota
 * si riporta solo se è una sola, perché una fattura al 22% e al 4% non ha
 * «l'aliquota».
 */
export function parseFatturaPA(xml: string): ExtractedDocument | null {
  if (!isFatturaPA(xml)) return null;
  const result = empty('fatturapa');
  const header = first(xml, 'FatturaElettronicaHeader');
  const body = blocks(xml, 'FatturaElettronicaBody')[0] ?? null;
  const general = first(body, 'DatiGenerali', 'DatiGeneraliDocumento');

  result.kind = 'INVOICE_PASSIVE';
  result.supplier = party(first(header, 'CedentePrestatore', 'DatiAnagrafici'));
  result.customer = party(first(header, 'CessionarioCommittente', 'DatiAnagrafici'));
  result.number = first(general, 'Numero');
  result.issueDate = isoDate(first(general, 'Data'));
  result.currency = first(general, 'Divisa');
  result.grossCents = xmlCents(first(general, 'ImportoTotaleDocumento'));

  const summaries = body === null ? [] : blocks(body, 'DatiRiepilogo');
  if (summaries.length > 0) {
    const net = summaries.map((s) => xmlCents(first(s, 'ImponibileImporto')) ?? 0);
    const vat = summaries.map((s) => xmlCents(first(s, 'Imposta')) ?? 0);
    const rates = new Set(summaries.map((s) => xmlCents(first(s, 'AliquotaIVA'))));
    result.netCents = net.reduce((a, b) => a + b, 0);
    result.vatCents = vat.reduce((a, b) => a + b, 0);
    const [rate] = [...rates];
    result.vatRateBp = rates.size === 1 && rate !== undefined ? rate : null;
    // Il totale non è obbligatorio nello schema: quando manca, è la somma.
    result.grossCents ??= result.netCents + result.vatCents;
  }

  result.dueDate = isoDate(
    first(body, 'DatiPagamento', 'DettaglioPagamento', 'DataScadenzaPagamento'),
  );
  result.vatNumbers = [result.supplier?.vatNumber, result.customer?.vatNumber].filter(
    (vat): vat is string => vat != null,
  );
  return result;
}

function isoDate(value: string | null): string | null {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * L'XML dentro un `.p7m`.
 *
 * Un `.p7m` è una busta CMS: la firma e, dentro, la fattura. La scorciatoia
 * diffusa — cercare `<?xml` fra i byte e tagliare alla chiusura — funziona
 * finché la busta tiene il contenuto in un pezzo solo. Molti firmatari lo
 * spezzano invece in blocchi da mille byte, ciascuno col suo piccolo
 * intestatario binario, e quei byte finirebbero in mezzo all'XML: la fattura
 * si leggerebbe a metà, o con un numero spezzato in due. Per questo si legge
 * la struttura (BER, con le lunghezze indefinite che la firma usa spesso) e si
 * ricuciono i blocchi.
 *
 * Alcuni `.p7m` arrivano in Base64 invece che in binario; si riconoscono e si
 * decodificano prima.
 */
export function extractXmlFromP7m(input: Uint8Array): string | null {
  const bytes = looksLikeBase64(input) ? decodeBase64(input) : input;
  if (bytes === null) return null;

  let found: string | null = null;
  const visit = (node: BerNode) => {
    if (found !== null) return;
    if (node.tag === 0x04 || node.tag === 0x24) {
      const content = octets(node);
      const text = decodeUtf8(content);
      if (isFatturaPA(text)) {
        found = text;
        return;
      }
    }
    node.children.forEach(visit);
  };

  try {
    for (const node of parseBer(bytes, 0, bytes.length)) visit(node);
  } catch {
    return null;
  }
  return found;
}

interface BerNode {
  tag: number;
  /** Il contenuto, per un nodo primitivo. */
  value: Uint8Array | null;
  children: BerNode[];
}

/** Il contenuto di una OCTET STRING, anche costruita a pezzi. */
function octets(node: BerNode): Uint8Array {
  if (node.value !== null) return node.value;
  const parts = node.children.map(octets);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** Legge i nodi fra `start` ed `end`; con `end` indefinito si ferma a `00 00`. */
function parseBer(bytes: Uint8Array, start: number, end: number): BerNode[] {
  return parseBerUntil(bytes, start, end, false).nodes;
}

function parseBerUntil(
  bytes: Uint8Array,
  start: number,
  end: number,
  indefinite: boolean,
): { nodes: BerNode[]; next: number } {
  const nodes: BerNode[] = [];
  let position = start;
  while (position < end) {
    if (indefinite && bytes[position] === 0 && bytes[position + 1] === 0) {
      return { nodes, next: position + 2 };
    }
    const tag = byteAt(bytes, position);
    position += 1;
    // I tag a più byte non compaiono in una busta di firma; se ce n'è uno, la
    // struttura non è quella attesa.
    if ((tag & 0x1f) === 0x1f) throw new Error('tag BER esteso non supportato');

    const lengthByte = byteAt(bytes, position);
    position += 1;
    const constructed = (tag & 0x20) !== 0;

    if (lengthByte === 0x80) {
      if (!constructed) throw new Error('lunghezza indefinita su un nodo primitivo');
      const inner = parseBerUntil(bytes, position, end, true);
      nodes.push({ tag, value: null, children: inner.nodes });
      position = inner.next;
      continue;
    }

    let length = lengthByte;
    if (lengthByte > 0x80) {
      const count = lengthByte & 0x7f;
      if (count > 4) throw new Error('lunghezza BER troppo grande');
      length = 0;
      for (let i = 0; i < count; i += 1) {
        length = length * 256 + byteAt(bytes, position);
        position += 1;
      }
    }
    const contentEnd = position + length;
    if (contentEnd > bytes.length) throw new Error('nodo BER troncato');

    nodes.push(
      constructed
        ? { tag, value: null, children: parseBer(bytes, position, contentEnd) }
        : { tag, value: bytes.subarray(position, contentEnd), children: [] },
    );
    position = contentEnd;
  }
  if (indefinite) throw new Error('fine dei contenuti mancante');
  return { nodes, next: position };
}

function byteAt(bytes: Uint8Array, position: number): number {
  const value = bytes[position];
  if (value === undefined) throw new Error('fine inattesa dei dati BER');
  return value;
}

function looksLikeBase64(bytes: Uint8Array): boolean {
  // Una busta binaria comincia con 0x30 (SEQUENCE); una in Base64 con «MI».
  const head = bytes.subarray(0, 64);
  return head.length > 0 && head.every((b) => /[A-Za-z0-9+/=\r\n]/.test(String.fromCharCode(b)));
}

/*
 * Base64 e UTF-8 scritti a mano, e non con `atob` e `TextDecoder`.
 *
 * `shared` non dipende da un ambiente: gira nel browser, in Node e nei test,
 * e il suo `tsconfig` non include né le librerie del DOM né i tipi di Node.
 * Le due funzioni esistono in entrambi, ma dichiararlo vorrebbe dire aprire la
 * porta a tutto il resto del DOM; venti righe costano meno.
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(bytes: Uint8Array): Uint8Array | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (char === '=' || char === '\r' || char === '\n') continue;
    const value = BASE64.indexOf(char);
    if (value === -1) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 in stringa; una sequenza non valida diventa «�», come fa il browser. */
function decodeUtf8(bytes: Uint8Array): string {
  let text = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    let code = 0xfffd;
    let size = 1;
    const continuation = (offset: number) => {
      const b = bytes[i + offset];
      return b !== undefined && (b & 0xc0) === 0x80 ? b & 0x3f : null;
    };
    if (b0 < 0x80) {
      code = b0;
    } else if (b0 >= 0xc2 && b0 < 0xe0) {
      const c1 = continuation(1);
      if (c1 !== null) [code, size] = [((b0 & 0x1f) << 6) | c1, 2];
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      const [c1, c2] = [continuation(1), continuation(2)];
      if (c1 !== null && c2 !== null) [code, size] = [((b0 & 0x0f) << 12) | (c1 << 6) | c2, 3];
    } else if (b0 >= 0xf0 && b0 < 0xf5) {
      const [c1, c2, c3] = [continuation(1), continuation(2), continuation(3)];
      if (c1 !== null && c2 !== null && c3 !== null) {
        [code, size] = [((b0 & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3, 4];
      }
    }
    text += String.fromCodePoint(code);
    i += size;
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Testo libero: PDF e OCR
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];

const DATE_PATTERN = new RegExp(
  [
    String.raw`\b(\d{4})-(\d{2})-(\d{2})\b`,
    String.raw`\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b`,
    String.raw`\b(\d{1,2})\s+(${MONTHS.join('|')})\s+(\d{4})\b`,
  ].join('|'),
  'gi',
);

/** Tutte le date di una riga, in ordine, già come `2026-03-15`. */
export function datesIn(line: string): string[] {
  const dates: string[] = [];
  for (const match of line.matchAll(DATE_PATTERN)) {
    let year: number;
    let month: number;
    let day: number;
    if (match[1] !== undefined) {
      [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    } else if (match[4] !== undefined) {
      day = Number(match[4]);
      month = Number(match[5]);
      const raw = match[6] ?? '';
      year = raw.length === 2 ? 2000 + Number(raw) : Number(raw);
    } else {
      day = Number(match[7]);
      month = MONTHS.indexOf((match[8] ?? '').toLowerCase()) + 1;
      year = Number(match[9]);
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    // `31/02/2026` diventerebbe il 3 marzo: si scarta invece di correggerla.
    if (
      year >= 2000 &&
      year <= 2100 &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      dates.push(date.toISOString().slice(0, 10));
    }
  }
  return dates;
}

/**
 * Gli importi di una riga, in centesimi.
 *
 * Solo quelli con due decimali, di proposito: «Fattura n. 2026» e «CAP 20121»
 * sono numeri, ma nessun totale si scrive senza centesimi su un documento
 * fiscale — ed è la regola che separa i soldi da tutto il resto della pagina.
 */
export function amountsIn(line: string): number[] {
  const pattern =
    /(?<![\d,.])-?\d{1,3}(?:[.,'\s]\d{3})*[.,]\d{2}(?![\d,.]*\d)|(?<![\d,.])-?\d+[.,]\d{2}(?![\d])/g;
  const amounts: number[] = [];
  for (const match of line.matchAll(pattern)) {
    const cents = parseAmountToCents(match[0].replace(/['\s]/g, ''));
    if (cents !== null) amounts.push(cents);
  }
  return amounts;
}

function normalizeVat(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[\s.-]/g, '');
  return /^IT\d{11}$/.test(cleaned) ? cleaned.slice(2) : cleaned;
}

/** Le partite IVA italiane del testo, verificate con la cifra di controllo. */
export function vatNumbersIn(text: string): string[] {
  const found = new Set<string>();
  // `(?<!\d)` e non `\b`: in «IT04552920482» fra la T e lo zero non c'è un
  // confine di parola, e il prefisso VIES farebbe sparire la partita IVA.
  for (const match of text.matchAll(/(?<!\d)(\d{11})(?!\d)/g)) {
    const candidate = match[1] ?? '';
    // Undici cifre qualsiasi sono anche un numero di telefono o un codice
    // cliente: la cifra di controllo le separa quasi tutte.
    if (hasValidVatChecksum(candidate)) found.add(candidate);
  }
  return [...found];
}

interface Line {
  text: string;
  lower: string;
}

/** Il valore di un'etichetta: sulla stessa riga dopo di lei, o su quella dopo. */
function afterLabel<T>(lines: Line[], label: RegExp, read: (text: string) => T[]): T | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = label.exec(line.text);
    if (match === null) continue;
    const rest = line.text.slice(match.index + match[0].length);
    const same = read(rest);
    if (same.length > 0) return same[0] ?? null;
    const next = lines[i + 1];
    if (next !== undefined) {
      const below = read(next.text);
      if (below.length > 0) return below[0] ?? null;
    }
  }
  return null;
}

const TOTAL_LABELS = [
  /totale\s+(?:documento|fattura|da\s+pagare|a\s+pagare|dovuto|complessivo|ricevuta)/i,
  /(?:netto|importo)\s+(?:a|da)\s+pagare/i,
  /importo\s+totale/i,
  /saldo\s+(?:finale|delega)/i,
  /\btotale\b(?!\s+(?:imponibile|iva|imposta))/i,
];

function guessKind(lower: string): DocumentKind | null {
  if (/modello\s+(?:di\s+pagamento\s+unificato\s+)?f24|delega\s+irrevocabile|\bf24\b/.test(lower)) {
    return 'F24';
  }
  if (/\bfattura\b|nota\s+di\s+credito|invoice/.test(lower)) return 'INVOICE_PASSIVE';
  if (/\bricevuta\b|scontrino|receipt/.test(lower)) return 'RECEIPT';
  if (/\bcontratto\b/.test(lower)) return 'CONTRACT';
  return null;
}

/**
 * Le regole sul testo di un PDF o di un OCR.
 *
 * Ogni campo ha la sua etichetta e si cerca **dopo** di lei, non ovunque:
 * «la prima data del documento» è spesso quella del contratto citato in
 * intestazione, e «l'importo più grande» è a volte il fido o il totale
 * dell'anno.
 */
export function extractFromText(text: string, source: 'text' | 'ocr' = 'text'): ExtractedDocument {
  const result = empty(source);
  const lines: Line[] = text
    .split(/\r?\n/)
    .map((raw) => raw.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .map((line) => ({ text: line, lower: line.toLowerCase() }));
  const all = lines.map((line) => line.lower).join('\n');

  result.kind = guessKind(all);

  result.number = afterLabel(
    lines,
    /(?:fattura|documento|ricevuta|nota\s+di\s+credito|invoice)\s*(?:n(?:r|um)?\.?|numero|n°|nº|#)\s*:?/i,
    (rest) => {
      const match = /^\s*([A-Z0-9][A-Z0-9\-/_.]*[A-Z0-9]|[A-Z0-9])/i.exec(rest);
      return match?.[1] === undefined ? [] : [match[1]];
    },
  );
  result.issueDate =
    afterLabel(
      lines,
      // «Data scadenza» è una data, ma non quella del documento.
      /\bdata(?!\s+(?:di\s+)?scadenza)(?:\s+(?:fattura|documento|emissione|ricevuta))?\s*:?|\bdel\b/i,
      datesIn,
    ) ??
    lines.flatMap((line) => datesIn(line.text))[0] ??
    null;
  result.dueDate = afterLabel(
    lines,
    /scadenza|da\s+pagare\s+entro|pagamento\s+entro|entro\s+il/i,
    datesIn,
  );

  for (const label of TOTAL_LABELS) {
    const amount = afterLabel(lines, label, amountsIn);
    if (amount !== null) {
      result.grossCents = amount;
      break;
    }
  }
  result.netCents = afterLabel(lines, /(?:totale\s+)?imponibile/i, amountsIn);
  const rate =
    /\biva\b[^\n%]{0,20}?(\d{1,2}(?:[.,]\d{1,2})?)\s*%|(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*(?:di\s+)?iva/i.exec(
      all,
    );
  const rateText = rate?.[1] ?? rate?.[2];
  if (rateText !== undefined) {
    const bp = parseAmountToCents(rateText);
    if (bp !== null && bp <= 10_000) result.vatRateBp = bp;
  }
  // L'IVA è la differenza quando c'è tutto il resto, come nel modulo: cercarla
  // per etichetta confonde l'importo con l'aliquota nella stessa riga.
  if (
    result.netCents !== null &&
    result.grossCents !== null &&
    result.grossCents >= result.netCents
  ) {
    result.vatCents = result.grossCents - result.netCents;
  }

  if (/\bUSD\b|\$\s?\d/.test(text) && !/€|\bEUR\b/.test(text)) result.currency = 'USD';
  else if (/€|\bEUR\b|euro/i.test(text)) result.currency = 'EUR';

  result.vatNumbers = vatNumbersIn(text);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Controparte
// ─────────────────────────────────────────────────────────────────────────────

export interface KnownParty {
  id: string;
  name: string;
  vatNumber?: string | null;
}

export interface ResolvedCounterparty {
  kind: DocumentKind | null;
  clientId: string | null;
  vendorId: string | null;
}

const sameVat = (a: string | null | undefined, b: string | null | undefined) =>
  a != null && b != null && normalizeVat(a) === normalizeVat(b);

/**
 * Chi è l'altra parte, fra i clienti e i fornitori che ci sono già.
 *
 * Una fattura porta due partite IVA, la nostra e quella dell'altro, ma
 * l'applicazione non conosce la nostra. Si decide quindi dall'anagrafica: se
 * il cedente è un fornitore la fattura è ricevuta, se il cessionario è un
 * cliente è emessa. Se nessuno dei due è noto, non si decide niente e il tipo
 * resta quello scelto a mano.
 *
 * Sul testo libero non si sa chi è il cedente: si provano tutte le partite IVA
 * trovate e, se nessuna combacia, i nomi — «Aruba» scritto in intestazione è
 * un indizio migliore di niente, e con i nomi corti si rischia troppo per
 * provarci.
 */
export function resolveCounterparty(
  extracted: ExtractedDocument,
  known: { clients: readonly KnownParty[]; vendors: readonly KnownParty[] },
  text = '',
): ResolvedCounterparty {
  const invoice = extracted.kind === 'INVOICE_PASSIVE' || extracted.kind === 'INVOICE_ACTIVE';

  if (extracted.source === 'fatturapa') {
    const vendor = known.vendors.find((v) => sameVat(v.vatNumber, extracted.supplier?.vatNumber));
    if (vendor !== undefined)
      return { kind: 'INVOICE_PASSIVE', clientId: null, vendorId: vendor.id };
    const client = known.clients.find((c) => sameVat(c.vatNumber, extracted.customer?.vatNumber));
    if (client !== undefined)
      return { kind: 'INVOICE_ACTIVE', clientId: client.id, vendorId: null };
    return { kind: null, clientId: null, vendorId: null };
  }

  const byVat = <T extends KnownParty>(parties: readonly T[]) =>
    parties.find((p) => extracted.vatNumbers.some((vat) => sameVat(p.vatNumber, vat)));
  const lower = text.toLowerCase();
  const byName = <T extends KnownParty>(parties: readonly T[]) =>
    parties.find((p) => {
      const name = p.name.trim().toLowerCase();
      return name.length >= 4 && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(lower);
    });

  const vendor = byVat(known.vendors) ?? byName(known.vendors);
  if (vendor !== undefined) {
    return { kind: invoice ? 'INVOICE_PASSIVE' : null, clientId: null, vendorId: vendor.id };
  }
  const client = byVat(known.clients) ?? byName(known.clients);
  if (client !== undefined) {
    return { kind: invoice ? 'INVOICE_ACTIVE' : null, clientId: client.id, vendorId: null };
  }
  return { kind: null, clientId: null, vendorId: null };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
