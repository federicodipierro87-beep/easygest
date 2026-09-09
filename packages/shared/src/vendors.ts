import { z } from 'zod';

import {
  checkItalianFiscalFields,
  countryCodeSchema,
  emailFieldSchema,
  nameSchema,
  notesSchema,
  optionalText,
  urlSchema,
  vatNumberSchema,
} from './fiscal';
import { buildListQuerySchema } from './resources';

/**
 * Fornitore: chi emette la spesa.
 *
 * Ha meno campi fiscali di un cliente e più campi operativi, e non è una
 * svista. A un cliente si emettono fatture, quindi servono partita IVA, codice
 * SDI e indirizzo. Da un fornitore si riceve e basta: quello che serve davvero
 * è ritrovare il contratto quando bisogna disdire, ed è per questo che ci sono
 * il numero cliente e la pagina del pannello.
 */
export const vendorInputSchema = z
  .strictObject({
    name: nameSchema,
    website: urlSchema.default(null),
    supportEmail: emailFieldSchema.default(null),
    /**
     * Numero cliente o identificativo del contratto presso il fornitore:
     * quando chiami per disdire è la prima cosa che ti chiedono, e cercarlo
     * nelle vecchie email mentre scade la finestra di recesso è esattamente il
     * problema che questa applicazione dovrebbe togliere di mezzo.
     */
    accountRef: optionalText(z.string().trim().max(120)).default(null),
    portalUrl: urlSchema.default(null),
    vatNumber: vatNumberSchema.default(null),
    countryCode: countryCodeSchema,
    notes: notesSchema.default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine(checkItalianFiscalFields);

export type VendorInput = z.infer<typeof vendorInputSchema>;

export interface Vendor {
  id: string;
  name: string;
  website: string | null;
  supportEmail: string | null;
  accountRef: string | null;
  portalUrl: string | null;
  vatNumber: string | null;
  countryCode: string;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  expenseCount: number;
  documentCount: number;
}

export const VENDOR_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;

export const vendorListQuerySchema = buildListQuerySchema(VENDOR_SORT_FIELDS, 'name');
export type VendorListQuery = z.infer<typeof vendorListQuerySchema>;
