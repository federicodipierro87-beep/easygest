import { z } from 'zod';

import { nameSchema, optionalText } from './fiscal';
import { buildListQuerySchema } from './resources';

/**
 * Categorie di spese e documenti.
 *
 * A differenza di clienti e fornitori una categoria non è un'anagrafica ma
 * un'etichetta: non ha campi propri da ricordare, esiste per raggruppare. Da
 * qui derivano le sue due particolarità — l'ordine manuale e l'ambito.
 */

/**
 * Dove si può usare una categoria.
 *
 * Sono cose diverse: «Hosting e server» classifica una spesa, «F24» classifica
 * un documento, «Consulenze» tutte e due. Senza questa distinzione il menù a
 * tendina della spesa proporrebbe «Contratti» e quello del documento
 * «Commissioni bancarie», e in un elenco di venti voci le sbagliate sono
 * rumore che si legge a ogni inserimento.
 */
export const categoryScopeSchema = z.enum(['EXPENSE', 'DOCUMENT', 'BOTH']);
export type CategoryScope = z.infer<typeof categoryScopeSchema>;

/**
 * Le icone selezionabili, come elenco chiuso.
 *
 * `lucide-react` ne esporta oltre mille. Risolvere un nome qualsiasi a runtime
 * richiederebbe di importarle tutte — `import * as icons` costa megabyte — e
 * il bundle è già l'unico debito aperto sul frontend. Un elenco fisso si
 * importa per nome, entra nel bundle solo per ciò che contiene, e in cambio
 * l'utente sceglie da una griglia invece di indovinare una stringa.
 *
 * Contiene le undici usate dal seed più qualcuna per le categorie che l'utente
 * si creerà: il tipo `CategoryIcon` è quello con cui il seed è scritto, quindi
 * toglierne una da qui non compila finché il seed non viene sistemato.
 */
export const CATEGORY_ICONS = [
  'server',
  'globe',
  'shield-check',
  'key-round',
  'repeat',
  'hard-drive',
  'wifi',
  'cpu',
  'graduation-cap',
  'users',
  'landmark',
  'file-text',
  'receipt',
  'briefcase',
  'mail',
  'smartphone',
  'cloud',
  'wrench',
  'car',
  'tag',
] as const;

export const categoryIconSchema = optionalText(
  z.enum(CATEGORY_ICONS, { message: 'Icona non riconosciuta' }),
);
export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

/**
 * Colore esadecimale, nella forma lunga.
 *
 * La forma breve `#abc` è legale in CSS e vale `#aabbcc`: viene espansa invece
 * che rifiutata, perché la colonna è `varchar(7)` e due scritture dello stesso
 * colore non devono risultare due colori. Il maiuscolo viene abbassato per la
 * stessa ragione.
 */
export const colorSchema = optionalText(
  z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => (value.startsWith('#') ? value : `#${value}`))
    .transform((value) =>
      /^#[0-9a-f]{3}$/.test(value)
        ? `#${value[1]!}${value[1]!}${value[2]!}${value[2]!}${value[3]!}${value[3]!}`
        : value,
    )
    .pipe(z.string().regex(/^#[0-9a-f]{6}$/, 'Il colore va scritto in esadecimale, es. #2563eb')),
);

/**
 * Quello che di una categoria può decidere l'utente.
 *
 * `isSystem` non c'è: lo assegna il seed e nessuna richiesta lo può cambiare,
 * altrimenti basterebbe una `PUT` per aggirare il rifiuto di cancellazione.
 * `sortOrder` neanche: lo gestisce il server, che mette le nuove in fondo.
 */
export const categoryInputSchema = z.strictObject({
  name: nameSchema,
  scope: categoryScopeSchema.default('BOTH'),
  color: colorSchema.default(null),
  icon: categoryIconSchema.default(null),
  isActive: z.boolean().default(true),
});

export type CategoryInput = z.infer<typeof categoryInputSchema>;

export interface Category {
  id: string;
  name: string;
  scope: CategoryScope;
  color: string | null;
  icon: CategoryIcon | null;
  /** Creata dal seed: si può modificare e archiviare, non cancellare. */
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  expenseCount: number;
  documentCount: number;
}

export const CATEGORY_SORT_FIELDS = ['sortOrder', 'name', 'createdAt'] as const;

/**
 * L'ordinamento predefinito è quello manuale, non alfabetico.
 *
 * Il seed numera le categorie per frequenza d'uso — hosting e domini prima,
 * formazione e consulenze poi — e in un menù a tendina è quello che serve:
 * l'alfabetico metterebbe «Backup e storage» sopra «Hosting e server» senza
 * che nessuno l'abbia chiesto.
 */
export const categoryListQuerySchema = buildListQuerySchema(
  CATEGORY_SORT_FIELDS,
  'sortOrder',
).extend({
  /**
   * Filtra per uso, non per valore esatto.
   *
   * `usableFor=EXPENSE` restituisce le categorie `EXPENSE` **e** quelle
   * `BOTH`, perché è la domanda che fa chi deve riempire un menù a tendina.
   * Si chiama così e non `scope` proprio per non far pensare a un confronto
   * secco, che darebbe un elenco incompleto senza sembrare sbagliato.
   */
  usableFor: categoryScopeSchema.exclude(['BOTH']).optional(),
});

export type CategoryListQuery = z.infer<typeof categoryListQuerySchema>;
