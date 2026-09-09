import { z } from 'zod';

import {
  addressLineSchema,
  checkItalianFiscalFields,
  citySchema,
  countryCodeSchema,
  emailFieldSchema,
  nameSchema,
  notesSchema,
  phoneSchema,
  postalCodeSchema,
  provinceSchema,
  sdiCodeSchema,
  taxCodeSchema,
  vatNumberSchema,
} from './fiscal';
import { buildListQuerySchema } from './resources';

/**
 * Cliente: chi paga, e a chi si riaddebitano le spese.
 *
 * L'oggetto che il form invia è lo stesso in creazione e in modifica.
 *
 * I campi facoltativi non sono `optional`: quando mancano valgono `null`, e la
 * modifica sostituisce il record per intero. L'alternativa — campo assente
 * significa «lascialo com'è» — sembra più elegante ma rende indistinguibile
 * «non l'ho toccato» da «cancellalo», e cancellare un dato sbagliato è
 * un'operazione che serve. Costa la riscrittura di tutte le colonne invece che
 * di quelle cambiate: a queste dimensioni non si misura.
 */
export const clientInputSchema = z
  .strictObject({
    name: nameSchema,
    vatNumber: vatNumberSchema.default(null),
    taxCode: taxCodeSchema.default(null),
    sdiCode: sdiCodeSchema.default(null),
    /**
     * La PEC è un recapito di fatturazione, non un indirizzo qualsiasi: se il
     * cliente non ha un codice SDI, la fattura elettronica arriva qui.
     */
    pecEmail: emailFieldSchema.default(null),
    email: emailFieldSchema.default(null),
    phone: phoneSchema.default(null),
    addressLine: addressLineSchema.default(null),
    postalCode: postalCodeSchema.default(null),
    city: citySchema.default(null),
    province: provinceSchema.default(null),
    countryCode: countryCodeSchema,
    notes: notesSchema.default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine(checkItalianFiscalFields);

export type ClientInput = z.infer<typeof clientInputSchema>;

/**
 * Cliente come esce dall'API.
 *
 * Le date sono stringhe ISO perché ci passa in mezzo JSON, che di date non ne
 * ha. I due contatori dicono da quante spese e da quanti documenti è
 * riferito: servono all'interfaccia per sapere in anticipo che la
 * cancellazione verrà rifiutata, invece di scoprirlo con un errore.
 */
export interface Client {
  id: string;
  name: string;
  vatNumber: string | null;
  taxCode: string | null;
  sdiCode: string | null;
  pecEmail: string | null;
  email: string | null;
  phone: string | null;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  province: string | null;
  countryCode: string;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  expenseCount: number;
  documentCount: number;
}

export const CLIENT_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;

export const clientListQuerySchema = buildListQuerySchema(CLIENT_SORT_FIELDS, 'name');
export type ClientListQuery = z.infer<typeof clientListQuerySchema>;
