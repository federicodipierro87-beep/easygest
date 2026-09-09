import { z } from 'zod';

import { notesSchema, optionalText } from './fiscal';
import { buildListQuerySchema } from './resources';

/**
 * Strumenti con cui una spesa viene pagata.
 *
 * Qui non si conservano credenziali: niente numero di carta, niente CVV,
 * niente IBAN. Servono due cose sole — riconoscere la riga in un estratto
 * conto, e sapere quando la carta scade. La seconda è il motivo per cui questa
 * entità esiste separata invece di essere una stringa sulla spesa: una carta
 * che scade blocca in silenzio tutti gli abbonamenti agganciati, e accorgersene
 * dalla prima fattura non pagata è tardi.
 */

export const paymentMethodTypeSchema = z.enum([
  'CARD',
  'SEPA_DIRECT_DEBIT',
  'BANK_TRANSFER',
  'PAYPAL',
  'CASH',
  'OTHER',
]);
export type PaymentMethodType = z.infer<typeof paymentMethodTypeSchema>;

/** Le etichette stanno qui e non nel frontend: le userà anche il testo delle email. */
export const PAYMENT_METHOD_TYPE_LABELS: Record<PaymentMethodType, string> = {
  CARD: 'Carta',
  SEPA_DIRECT_DEBIT: 'Addebito SEPA',
  BANK_TRANSFER: 'Bonifico',
  PAYPAL: 'PayPal',
  CASH: 'Contanti',
  OTHER: 'Altro',
};

/**
 * Numero facoltativo proveniente da un form.
 *
 * È l'equivalente di `optionalText` per i campi numerici: una casella non
 * compilata arriva come `""`, che `z.coerce.number()` convertirebbe
 * volentieri in `0` — un mese di scadenza pari a zero, salvato senza che
 * nessuno protesti.
 */
function optionalNumber<S extends z.ZodType>(schema: S) {
  return z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : value),
    z.union([schema, z.null()]),
  );
}

export const labelSchema = z
  .string()
  .trim()
  .min(1, 'Il nome è obbligatorio')
  .max(120, 'Il nome non può superare 120 caratteri');

/**
 * Ultime quattro cifre, per riconoscere la riga sull'estratto conto.
 *
 * Non è vincolato al tipo `CARD`: le ultime quattro di un IBAN identificano un
 * addebito SEPA esattamente allo stesso modo, e rifiutarle costringerebbe a
 * scriverle nelle note.
 */
export const last4Schema = optionalText(
  z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Servono esattamente 4 cifre'),
);

export const paymentMethodInputSchema = z
  .strictObject({
    label: labelSchema,
    type: paymentMethodTypeSchema,
    last4: last4Schema.default(null),
    expiryMonth: optionalNumber(
      z.coerce.number().int().min(1, 'Il mese va da 1 a 12').max(12, 'Il mese va da 1 a 12'),
    ).default(null),
    /**
     * L'anno non viene confrontato con oggi: registrare una carta appena
     * scaduta, per sapere quali abbonamenti spostare, è un uso legittimo.
     * L'avviso di scadenza è un problema di presentazione, non di validità.
     */
    expiryYear: optionalNumber(
      z.coerce.number().int().min(2000, 'Anno non plausibile').max(2100, 'Anno non plausibile'),
    ).default(null),
    notes: notesSchema.default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    // Un mese senza anno non è una scadenza, è metà di un dato: passerebbe la
    // validazione, si salverebbe, e il promemoria della Fase 4 non saprebbe
    // che farsene senza che nessuno abbia mai visto un errore.
    if (value.expiryMonth !== null && value.expiryYear === null) {
      ctx.addIssue({ code: 'custom', path: ['expiryYear'], message: 'Manca l’anno di scadenza' });
    }
    if (value.expiryYear !== null && value.expiryMonth === null) {
      ctx.addIssue({ code: 'custom', path: ['expiryMonth'], message: 'Manca il mese di scadenza' });
    }
  });

export type PaymentMethodInput = z.infer<typeof paymentMethodInputSchema>;

/**
 * Quello che un modulo manda, prima che lo schema lo converta.
 *
 * È l'unica entità in cui i due tipi divergono: `expiryMonth` esce numero ma
 * entra come la stringa che una casella produce, e `z.coerce` esiste apposta.
 * Dichiarare il tipo d'ingresso invece di forzare quello d'uscita con un cast
 * evita di dire a TypeScript una cosa falsa — e soprattutto continuerebbe a
 * funzionare se un domani un campo cambiasse forma.
 */
export type PaymentMethodFormInput = z.input<typeof paymentMethodInputSchema>;

/**
 * Un metodo di pagamento non ha `documentCount`: nessun documento vi punta,
 * solo le spese. Il conteggio assente non è un'omissione da correggere quando
 * si copia da `Client`.
 */
export interface PaymentMethod {
  id: string;
  label: string;
  type: PaymentMethodType;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  expenseCount: number;
}

export const PAYMENT_METHOD_SORT_FIELDS = ['label', 'type', 'createdAt'] as const;

export const paymentMethodListQuerySchema = buildListQuerySchema(
  PAYMENT_METHOD_SORT_FIELDS,
  'label',
);
export type PaymentMethodListQuery = z.infer<typeof paymentMethodListQuerySchema>;

/**
 * Mese in cui la carta smette di funzionare, come istante confrontabile.
 *
 * Una carta con scadenza 03/2027 è valida per **tutto** marzo: il confine è
 * l'inizio di aprile. Calcolarlo con `month` invece che `month + 1` la
 * dichiarerebbe scaduta un mese prima, e il promemoria arriverebbe mentre la
 * carta funziona ancora.
 */
export function expiresBefore(expiryMonth: number, expiryYear: number): Date {
  return new Date(Date.UTC(expiryYear, expiryMonth, 1));
}
