import Anthropic from '@anthropic-ai/sdk';
import { parseAmountToCents } from '@easygest/shared';
import type { ExtractedDocument, ExtractedParty } from '@easygest/shared/extraction';
import { z } from 'zod';

/**
 * Leggere un documento con Claude.
 *
 * È la strada precisa della compilazione automatica: le regole locali di
 * `extraction.ts` cercano etichette, e ogni gestionale impagina a modo suo; un
 * modello legge la fattura come la legge una persona. Il prezzo è che il file
 * esce dalla nostra infrastruttura e va ad Anthropic, e costa qualche
 * centesimo: per questo parte solo quando lo si chiede, con un bottone, e mai
 * da sé.
 *
 * Il modello restituisce un JSON vincolato da uno schema (`output_config.format`),
 * e lo schema si ricontrolla qui con Zod: il vincolo garantisce la forma, non
 * che una data sia una data vera o che un importo sia un numero.
 */

export interface DocumentReader {
  read(input: { bytes: Buffer; mimeType: string }): Promise<ExtractedDocument>;
}

export class ReaderError extends Error {
  constructor(
    readonly code: 'AI_UNSUPPORTED_FILE' | 'AI_REFUSED' | 'AI_INCOMPLETE' | 'AI_INVALID_OUTPUT',
    message: string,
  ) {
    super(message);
    this.name = 'ReaderError';
  }
}

/** I tipi che Claude accetta come documento o come immagine. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const partySchema = {
  anyOf: [
    {
      type: 'object',
      properties: { name: nullableString, vatNumber: nullableString },
      required: ['name', 'vatNumber'],
      additionalProperties: false,
    },
    { type: 'null' },
  ],
};

/**
 * Lo schema della risposta.
 *
 * Gli importi sono **stringhe** con il punto decimale e non numeri: un numero
 * in virgola mobile trasforma 0,1 in 0,1000000000000000055, e i centesimi di
 * una fattura non devono passare di lì. Ogni campo ammette `null`, e il prompt
 * chiede di usarlo: un campo vuoto è una domanda, uno inventato un errore.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    documentType: {
      type: 'string',
      enum: ['fattura', 'nota_di_credito', 'ricevuta', 'f24', 'contratto', 'altro'],
    },
    number: nullableString,
    issueDate: nullableString,
    dueDate: nullableString,
    currency: nullableString,
    netAmount: nullableString,
    vatRate: nullableString,
    vatAmount: nullableString,
    totalAmount: nullableString,
    supplier: partySchema,
    customer: partySchema,
  },
  required: [
    'documentType',
    'number',
    'issueDate',
    'dueDate',
    'currency',
    'netAmount',
    'vatRate',
    'vatAmount',
    'totalAmount',
    'supplier',
    'customer',
  ],
  additionalProperties: false,
} as const;

const partyOutput = z.object({ name: z.string().nullable(), vatNumber: z.string().nullable() });
const readingSchema = z.object({
  documentType: z.enum(['fattura', 'nota_di_credito', 'ricevuta', 'f24', 'contratto', 'altro']),
  number: z.string().nullable(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  currency: z.string().nullable(),
  netAmount: z.string().nullable(),
  vatRate: z.string().nullable(),
  vatAmount: z.string().nullable(),
  totalAmount: z.string().nullable(),
  supplier: partyOutput.nullable(),
  customer: partyOutput.nullable(),
});
export type Reading = z.infer<typeof readingSchema>;

const SYSTEM_PROMPT = `Leggi un documento fiscale italiano di un libero professionista (fattura, nota di credito, ricevuta, modello F24, contratto) e riporta i suoi dati nello schema richiesto.

Riporta solo ciò che è scritto sul documento. Se un dato non c'è o non si legge con sicurezza, usa null: un campo vuoto viene compilato a mano, uno sbagliato finisce in contabilità.

- Date nel formato AAAA-MM-GG. issueDate è la data del documento, dueDate la scadenza del pagamento.
- Importi come stringa con il punto decimale e due decimali, senza simbolo di valuta né separatori delle migliaia: "1234.56". Per un F24 totalAmount è il saldo finale.
- vatRate è l'aliquota IVA in percentuale, come "22"; se il documento ne applica più di una, null. netAmount e vatAmount sono i totali di imponibile e IVA del documento.
- currency è il codice ISO a tre lettere, come "EUR".
- supplier è chi ha emesso il documento (cedente o prestatore), customer chi lo riceve (cessionario o committente). vatNumber è la partita IVA con le sole cifre, senza il prefisso "IT"; per un'azienda estera tieni il prefisso del paese.
- number è il numero del documento come è scritto, senza "n." davanti.`;

export interface ClaudeReaderOptions {
  apiKey: string;
  model: string;
}

export function createClaudeReader({ apiKey, model }: ClaudeReaderOptions): DocumentReader {
  const client = new Anthropic({ apiKey });

  return {
    async read({ bytes, mimeType }) {
      const data = bytes.toString('base64');
      let source: Anthropic.Beta.BetaContentBlockParam;
      if (mimeType === 'application/pdf') {
        source = {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data },
        };
      } else if ((IMAGE_TYPES as readonly string[]).includes(mimeType)) {
        source = {
          type: 'image',
          source: { type: 'base64', media_type: mimeType as ImageType, data },
        };
      } else {
        throw new ReaderError(
          'AI_UNSUPPORTED_FILE',
          'Si leggono con l’AI solo PDF e immagini: una fattura elettronica si legge già da sé.',
        );
      }

      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // Se un classificatore di sicurezza rifiuta la richiesta, la rilancia
        // lato server sul modello che Anthropic raccomanda per quella
        // categoria. Per una fattura non dovrebbe succedere mai; se succede,
        // meglio una risposta da un altro modello che un bottone che non fa
        // niente.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM_PROMPT,
        output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        messages: [
          {
            role: 'user',
            content: [source, { type: 'text', text: 'Estrai i dati di questo documento.' }],
          },
        ],
      });

      if (response.stop_reason === 'refusal') {
        throw new ReaderError('AI_REFUSED', 'Il modello non ha voluto leggere questo documento.');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new ReaderError('AI_INCOMPLETE', 'La lettura si è interrotta prima della fine.');
      }
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ReaderError('AI_INVALID_OUTPUT', 'La risposta del modello non è leggibile.');
      }
      const parsed = readingSchema.safeParse(json);
      if (!parsed.success) {
        throw new ReaderError(
          'AI_INVALID_OUTPUT',
          'La risposta del modello non ha la forma attesa.',
        );
      }
      return toExtracted(parsed.data);
    },
  };
}

/**
 * Dalla risposta del modello al formato di tutte le altre letture.
 *
 * Qui si rifanno i controlli che lo schema non può fare: una data che non
 * esiste, un importo che non è un numero, una partita IVA con spazi. Quello
 * che non passa diventa `null`, e la casella resta da compilare.
 */
export function toExtracted(reading: Reading): ExtractedDocument {
  const kind = {
    fattura: 'INVOICE_PASSIVE',
    nota_di_credito: 'INVOICE_PASSIVE',
    ricevuta: 'RECEIPT',
    f24: 'F24',
    contratto: 'CONTRACT',
    altro: null,
  } as const;
  const supplier = party(reading.supplier);
  const customer = party(reading.customer);
  const rate = cents(reading.vatRate);
  return {
    source: 'ai',
    kind: kind[reading.documentType],
    number: text(reading.number),
    issueDate: isoDate(reading.issueDate),
    dueDate: isoDate(reading.dueDate),
    netCents: cents(reading.netAmount),
    vatRateBp: rate !== null && rate >= 0 && rate <= 10_000 ? rate : null,
    vatCents: cents(reading.vatAmount),
    grossCents: cents(reading.totalAmount),
    currency: /^[A-Z]{3}$/.test(reading.currency ?? '') ? reading.currency : null,
    supplier,
    customer,
    vatNumbers: [supplier?.vatNumber, customer?.vatNumber].filter(
      (vat): vat is string => vat != null,
    ),
  };
}

function text(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function cents(value: string | null): number | null {
  const trimmed = text(value);
  return trimmed === null ? null : parseAmountToCents(trimmed);
}

function isoDate(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  // `2026-02-31` passerebbe la regex e diventerebbe il 3 marzo.
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? value : null;
}

function party(value: Reading['supplier']): ExtractedParty | null {
  if (value === null) return null;
  const vat = value.vatNumber?.toUpperCase().replace(/[\s.-]/g, '') ?? '';
  return {
    name: text(value.name),
    vatNumber: vat === '' ? null : /^IT\d{11}$/.test(vat) ? vat.slice(2) : vat,
  };
}
