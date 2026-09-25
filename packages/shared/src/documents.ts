import { z } from 'zod';

import { currencySchema, vatRateBpSchema } from './expenses';
import { notesSchema, optionalText } from './fiscal';
import { isoDateSchema } from './recurrence';
import { buildListQuerySchema } from './resources';

/**
 * L'archivio dei documenti: fatture, F24, contratti, ricevute.
 *
 * Un documento sono due cose che vivono in due posti diversi — il file su uno
 * storage S3, i metadati qui — e nascono in due tempi. Prima si chiede dove
 * caricare (`documentUploadRequestSchema`), il browser carica direttamente sul
 * bucket, poi si registra il documento (`documentCreateSchema`) e l'API
 * controlla che il file annunciato ci sia davvero. Il file non passa mai
 * dall'API: né il proxy di Netlify né il container di Railway sono posti in
 * cui far transitare venticinque mega.
 */

export const DOCUMENT_KINDS = [
  'INVOICE_ACTIVE',
  'INVOICE_PASSIVE',
  'F24',
  'CONTRACT',
  'COMMUNICATION',
  'RECEIPT',
  'OTHER',
] as const;
export const documentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  INVOICE_ACTIVE: 'Fattura emessa',
  INVOICE_PASSIVE: 'Fattura ricevuta',
  F24: 'F24',
  CONTRACT: 'Contratto',
  COMMUNICATION: 'Comunicazione',
  RECEIPT: 'Ricevuta',
  OTHER: 'Altro',
};

/**
 * I tipi di file ammessi.
 *
 * Un elenco chiuso e non «qualunque cosa»: il file si riapre nel browser con
 * un URL firmato, e un HTML caricato come documento verrebbe servito dal
 * bucket con il suo tipo. Qui c'è quello che un professionista archivia
 * davvero — PDF, scansioni, e la fattura elettronica, che è un XML o, firmata,
 * un `.p7m`.
 */
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/xml',
  'text/xml',
  'application/pkcs7-mime',
] as const;
export const documentMimeTypeSchema = z.enum(DOCUMENT_MIME_TYPES, {
  error: 'Tipo di file non ammesso: servono PDF, immagini o fatture elettroniche',
});
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

/**
 * Il tipo dal nome, per quando il browser non lo sa.
 *
 * Succede proprio con i file che contano: un `.p7m` arriva con il tipo vuoto,
 * e un `.xml` a volte come `text/xml`, a volte come `application/xml`.
 */
export function mimeTypeFromFileName(fileName: string): DocumentMimeType | null {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'xml':
      return 'application/xml';
    case 'p7m':
      return 'application/pkcs7-mime';
    default:
      return null;
  }
}

/** Codici di errore propri dei documenti, da usare in uno `switch`. */
export const DOCUMENT_ERROR_CODES = {
  /** Una relazione punta a un record di un altro utente, o inesistente. */
  unknownRelation: 'UNKNOWN_RELATION',
  /** Il file annunciato non è sullo storage: il caricamento non è finito. */
  uploadMissing: 'UPLOAD_MISSING',
  /** Il file sullo storage non è quello annunciato. */
  uploadMismatch: 'UPLOAD_MISMATCH',
  /** Il file supera `DOCUMENT_MAX_BYTES`. */
  fileTooLarge: 'FILE_TOO_LARGE',
} as const;

export const checksumSha256Schema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{64}$/, 'Impronta SHA-256 non valida');

const fileNameSchema = z
  .string()
  .trim()
  .min(1, 'Il nome del file è obbligatorio')
  .max(255, 'Nome del file troppo lungo');

/** Cosa si annuncia prima di caricare. */
export const documentUploadRequestSchema = z.strictObject({
  fileName: fileNameSchema,
  mimeType: documentMimeTypeSchema,
  sizeBytes: z.number().int().min(1, 'Il file è vuoto'),
  checksumSha256: checksumSha256Schema,
});
export type DocumentUploadRequest = z.infer<typeof documentUploadRequestSchema>;

/**
 * La risposta: dove caricare, e se lo stesso file c'è già.
 *
 * I doppioni sono un avviso e non un rifiuto, come dice lo schema: lo stesso
 * PDF può servire due volte — un contratto allegato a due clienti — e
 * bloccarlo sarebbe più fastidioso che utile.
 */
export interface DocumentUploadTicket {
  storageKey: string;
  upload: {
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: string;
  };
  duplicates: DocumentDuplicate[];
}

export interface DocumentDuplicate {
  id: string;
  title: string;
  kind: DocumentKind;
  issueDate: string;
}

const amountCentsSchema = z.number().int('Gli importi sono interi in centesimi').min(0).max(1e13);

const relationIdSchema = optionalText(z.string().trim().max(40));

const tagsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(40))
  .max(20, 'Al massimo venti etichette')
  // Senza doppioni e in ordine: `['f24','inps']` e `['inps','f24','f24']` sono
  // la stessa cosa, e devono esserlo anche per chi confronta due documenti.
  .transform((tags) => [...new Set(tags)].sort());

/**
 * Quello che di un documento può decidere l'utente.
 *
 * Gli importi sono tutti facoltativi e **non** si completano a vicenda come in
 * una spesa: un documento registra quello che c'è scritto sopra, e un
 * contratto o una comunicazione non hanno importi affatto. Inventare un
 * imponibile a partire dal totale sarebbe scrivere nell'archivio un numero che
 * sul foglio non c'è.
 */
export const documentInputSchema = z
  .strictObject({
    kind: documentKindSchema,
    title: z
      .string()
      .trim()
      .min(1, 'Il titolo è obbligatorio')
      .max(200, 'Il titolo non può superare 200 caratteri'),
    number: optionalText(z.string().trim().max(60)).default(null),

    issueDate: isoDateSchema,
    dueDate: isoDateSchema.nullish().default(null),
    periodStart: isoDateSchema.nullish().default(null),
    periodEnd: isoDateSchema.nullish().default(null),
    paidAt: z.coerce.date().nullish().default(null),

    clientId: relationIdSchema.default(null),
    vendorId: relationIdSchema.default(null),
    categoryId: relationIdSchema.default(null),

    netCents: amountCentsSchema.nullish().default(null),
    vatRateBp: vatRateBpSchema.nullish().default(null),
    vatCents: amountCentsSchema.nullish().default(null),
    grossCents: amountCentsSchema.nullish().default(null),
    currency: currencySchema.default('EUR'),

    tags: tagsSchema.default([]),
    notes: notesSchema.default(null),
  })
  .superRefine((value, ctx) => {
    if (
      value.periodStart != null &&
      value.periodEnd != null &&
      value.periodEnd < value.periodStart
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['periodEnd'],
        message: 'Il periodo finisce prima di cominciare',
      });
    }
    if (value.netCents != null && value.grossCents != null && value.grossCents < value.netCents) {
      ctx.addIssue({
        code: 'custom',
        path: ['grossCents'],
        message: 'Il totale non può essere minore dell’imponibile',
      });
    }
    // Una fattura emessa ha una controparte che è un cliente, una ricevuta un
    // fornitore. Tutte e due insieme vorrebbe dire che il documento racconta
    // due storie, e il margine per cliente lo conterebbe dalla parte sbagliata.
    if (value.kind === 'INVOICE_ACTIVE' && value.vendorId != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['vendorId'],
        message: 'Una fattura emessa va a un cliente, non a un fornitore',
      });
    }
    if (value.kind === 'INVOICE_PASSIVE' && value.clientId != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['clientId'],
        message: 'Una fattura ricevuta arriva da un fornitore, non da un cliente',
      });
    }
  });
export type DocumentInput = z.infer<typeof documentInputSchema>;

/**
 * La registrazione: i metadati più il file già caricato.
 *
 * `storageKey` torna indietro così com'è stata data dal biglietto di
 * caricamento; l'API verifica che appartenga a chi la usa, quindi non serve
 * né basta indovinarla.
 */
export const documentCreateSchema = z.strictObject({
  document: documentInputSchema,
  file: documentUploadRequestSchema.extend({
    storageKey: z.string().trim().min(1).max(200),
  }),
});
export type DocumentCreate = z.infer<typeof documentCreateSchema>;

export const DOCUMENT_SORT_FIELDS = [
  'issueDate',
  'dueDate',
  'title',
  'createdAt',
  'grossCents',
] as const;

/**
 * I parametri dell'elenco.
 *
 * Con `q` l'ordine di default diventa la pertinenza, e `sort` viene ignorato:
 * chi cerca «aruba» vuole in cima la fattura di Aruba, non la più recente
 * fra quelle che nominano Aruba nelle note.
 */
export const documentListQuerySchema = buildListQuerySchema(DOCUMENT_SORT_FIELDS, 'issueDate')
  .omit({ archived: true })
  .extend({
    direction: z.enum(['asc', 'desc']).default('desc'),
    kind: documentKindSchema.optional(),
    clientId: z.string().trim().min(1).optional(),
    vendorId: z.string().trim().min(1).optional(),
    categoryId: z.string().trim().min(1).optional(),
    tag: z.string().trim().toLowerCase().min(1).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  });
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export interface Document {
  id: string;
  kind: DocumentKind;
  title: string;
  number: string | null;

  issueDate: string;
  dueDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;

  clientId: string | null;
  vendorId: string | null;
  categoryId: string | null;
  clientName: string | null;
  vendorName: string | null;
  categoryName: string | null;

  netCents: number | null;
  vatRateBp: number | null;
  vatCents: number | null;
  grossCents: number | null;
  currency: string;

  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string | null;

  tags: string[];
  notes: string | null;
  /** Le scadenze delle spese a cui questo documento è allegato. */
  occurrenceCount: number;

  createdAt: string;
  updatedAt: string;
}

/** Un URL firmato per aprire o scaricare il file, che scade in pochi minuti. */
export interface DocumentDownload {
  url: string;
}
