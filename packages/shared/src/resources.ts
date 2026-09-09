import { z } from 'zod';

/**
 * Convenzioni comuni a tutte le risorse con elenco e CRUD.
 *
 * Clienti e fornitori sono i primi, ma spese e documenti arriveranno con le
 * stesse esigenze: cercare, ordinare, paginare. Deciderle una volta qui evita
 * che ogni elenco inventi i propri nomi di parametri e che il frontend debba
 * ricordarsi quale usa cosa.
 */

/** Codici stabili, pensati per essere usati in uno `switch` dal frontend. */
export const RESOURCE_ERROR_CODES = {
  /** Esiste già un record con quel nome per questo utente. */
  duplicateName: 'DUPLICATE_NAME',
  /** Non si può cancellare: è collegato a spese o documenti. */
  inUse: 'RESOURCE_IN_USE',
} as const;

export type ResourceErrorCode = (typeof RESOURCE_ERROR_CODES)[keyof typeof RESOURCE_ERROR_CODES];

/** Dettagli allegati a un errore `RESOURCE_IN_USE`, per spiegare cosa lo trattiene. */
export interface ResourceInUseDetails {
  expenses: number;
  documents: number;
}

export const DEFAULT_PER_PAGE = 25;
export const MAX_PER_PAGE = 100;

/**
 * Cosa fare degli archiviati.
 *
 * Sono tre casi e non un booleano: la vista normale li nasconde, una casella
 * «mostra archiviati» li aggiunge, e serve anche poterli vedere da soli per
 * ripescarne uno. Con un booleano il terzo caso non si esprime.
 */
export const archivedFilterSchema = z.enum(['exclude', 'include', 'only']).default('exclude');
export type ArchivedFilter = z.infer<typeof archivedFilterSchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

/**
 * Parametri di un elenco.
 *
 * I campi ordinabili sono un elenco chiuso e non una stringa libera: il valore
 * finisce nell'`orderBy` di una query, e accettare qualunque nome di colonna
 * significherebbe far scegliere a chi chiama su cosa ordinare il database.
 *
 * La paginazione è per numero di pagina e non per cursore. Un cursore regge
 * meglio elenchi enormi, ma non permette di saltare alla pagina sette e mal
 * sopporta l'ordinamento su una colonna qualsiasi, che qui è il caso normale.
 * Le anagrafiche di un professionista stanno nell'ordine delle decine.
 */
export function buildListQuerySchema<const F extends readonly [string, ...string[]]>(
  sortFields: F,
  defaultSort: F[number],
) {
  return z.object({
    /** Testo cercato. Assente o vuoto vale come «nessun filtro». */
    q: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((value) => (value === undefined || value === '' ? undefined : value)),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(MAX_PER_PAGE).default(DEFAULT_PER_PAGE),
    archived: archivedFilterSchema,
    sort: z.enum(sortFields).default(defaultSort),
    direction: sortDirectionSchema.default('asc'),
  });
}

/**
 * Risposta di un elenco.
 *
 * `total` e `totalPages` viaggiano sempre, anche quando costano una `count` in
 * più: senza, l'interfaccia non può disegnare la paginazione e si riduce a un
 * «avanti» che a volte non porta da nessuna parte.
 */
export interface Paginated<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}
