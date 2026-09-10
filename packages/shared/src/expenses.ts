import { z } from 'zod';

import { nameSchema, notesSchema, optionalText } from './fiscal';
import { applyBasisPoints, grossFromNet, splitGross } from './money';
import { isoDateSchema, recurrenceUnitSchema } from './recurrence';
import { buildListQuerySchema } from './resources';

/**
 * Le spese, e le occorrenze che ne discendono.
 *
 * È la prima entità che usa tutte e quattro le anagrafiche insieme, ed è anche
 * la prima in cui i campi non sono indipendenti: l'unità di ricorrenza decide
 * se una data di fine ha senso, il modo di riaddebito decide quale dei due
 * importi accessori è obbligatorio, e l'importo si può scrivere al netto o al
 * lordo ma non in nessun modo. Tutte queste regole stanno qui e non nelle
 * rotte, così valgono identiche per l'API, per il seed e per il form.
 */

export const EXPENSE_STATUSES = ['ACTIVE', 'PAUSED', 'CANCELLED', 'ENDED'] as const;
export const expenseStatusSchema = z.enum(EXPENSE_STATUSES);
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  ACTIVE: 'Attiva',
  PAUSED: 'Sospesa',
  CANCELLED: 'Disdetta',
  ENDED: 'Conclusa',
};

/**
 * Gli stati che continuano a produrre occorrenze.
 *
 * Sospesa e disdetta si comportano allo stesso modo qui — nessuna generazione —
 * ma restano due stati distinti perché raccontano cose diverse: una sospensione
 * finisce, una disdetta no.
 */
export function generatesOccurrences(status: ExpenseStatus): boolean {
  return status === 'ACTIVE';
}

export const REBILL_MODES = ['NONE', 'PASSTHROUGH', 'MARKUP', 'FIXED'] as const;
export const rebillModeSchema = z.enum(REBILL_MODES);
export type RebillMode = (typeof REBILL_MODES)[number];

export const REBILL_MODE_LABELS: Record<RebillMode, string> = {
  NONE: 'Non riaddebitata',
  PASSTHROUGH: 'Riaddebito al costo',
  MARKUP: 'Riaddebito con ricarico',
  FIXED: 'Riaddebito a forfait',
};

export const OCCURRENCE_STATUSES = ['PLANNED', 'PAID', 'SKIPPED', 'CANCELLED'] as const;
export const occurrenceStatusSchema = z.enum(OCCURRENCE_STATUSES);
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const OCCURRENCE_STATUS_LABELS: Record<OccurrenceStatus, string> = {
  PLANNED: 'Prevista',
  PAID: 'Pagata',
  SKIPPED: 'Saltata',
  CANCELLED: 'Annullata',
};

/** Codici di errore propri delle spese, da usare in uno `switch`. */
export const EXPENSE_ERROR_CODES = {
  /** Una relazione punta a un record di un altro utente, o inesistente. */
  unknownRelation: 'UNKNOWN_RELATION',
  /** Manca il tasso di cambio per convertire la valuta nella valuta base. */
  missingFxRate: 'MISSING_FX_RATE',
  /** La transizione di stato richiesta non è ammessa da quella attuale. */
  invalidTransition: 'INVALID_OCCURRENCE_TRANSITION',
} as const;

export type ExpenseErrorCode = (typeof EXPENSE_ERROR_CODES)[keyof typeof EXPENSE_ERROR_CODES];

/**
 * Cosa trattiene una spesa che non si può cancellare.
 *
 * Il codice è lo stesso `RESOURCE_IN_USE` delle anagrafiche, ma i dettagli no,
 * ed è giusto che restino due tipi. Là trattengono due cose — spese e documenti
 * — che si vanno a guardare da altre due pagine; qui ne trattiene una sola, e
 * non sono le occorrenze in totale ma quelle già registrate, cioè quelle il cui
 * stato non è più «prevista». Un tipo unico con tre campi facoltativi
 * costringerebbe chi legge a indovinare quali sono valorizzati.
 */
export interface ExpenseInUseDetails {
  occurrences: number;
}

/** Identificativo di una relazione, oppure niente. */
const relationIdSchema = optionalText(z.string().trim().max(40));

/**
 * Codice valuta ISO 4217.
 *
 * Normalizzato a maiuscolo perché `eur` e `EUR` sono la stessa valuta ma due
 * stringhe diverse, e la colonna è la chiave con cui si cerca il cambio.
 */
export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z]{3}$/, 'La valuta va scritta come codice ISO, es. EUR'));

/** Aliquota IVA in basis point: da 0 (esente) a 100%. */
export const vatRateBpSchema = z
  .number()
  .int('L\u2019aliquota va espressa in basis point interi')
  .min(0)
  .max(10_000, 'Un\u2019aliquota oltre il 100% non esiste');

const amountCentsSchema = z
  .number()
  .int('Gli importi sono interi in centesimi')
  .min(0, 'Un importo negativo non è una spesa')
  .max(1e13);

/**
 * L'importo, scritto come lo si ha sotto mano.
 *
 * Molti fornitori SaaS espongono solo la cifra addebitata sulla carta, che è il
 * lordo; una fattura italiana espone l'imponibile. Chiedere sempre lo stesso
 * dei due costringerebbe a fare un conto a mano prima di inserire una spesa, e
 * quel conto è precisamente ciò che `money.ts` esiste per fare.
 *
 * Se arrivano entrambi vengono tenuti così come sono, senza ricalcolo. Non è
 * pigrizia: un fornitore che arrotonda l'IVA riga per riga produce un totale
 * che non coincide con l'aliquota applicata al totale imponibile, e in quel
 * caso ha ragione la fattura, non noi. L'unico vincolo è che il lordo non sia
 * minore del netto, che sarebbe un'IVA negativa.
 */
const amountFields = {
  netCents: amountCentsSchema.nullish(),
  grossCents: amountCentsSchema.nullish(),
  vatRateBp: vatRateBpSchema.default(2200),
};

export interface ResolvedAmount {
  netCents: number;
  vatCents: number;
  grossCents: number;
}

/**
 * Completa la coppia netto/lordo a partire da quello che c'è.
 *
 * Esportata perché la usano il seed e le correzioni sulle singole occorrenze,
 * non solo la creazione di una spesa.
 */
export function resolveAmount(input: {
  netCents?: number | null;
  grossCents?: number | null;
  vatRateBp: number;
}): ResolvedAmount {
  const { netCents, grossCents, vatRateBp } = input;

  if (netCents != null && grossCents != null) {
    return { netCents, vatCents: grossCents - netCents, grossCents };
  }
  if (netCents != null) {
    const gross = grossFromNet(netCents, vatRateBp);
    return { netCents, vatCents: gross - netCents, grossCents: gross };
  }
  if (grossCents != null) {
    const split = splitGross(grossCents, vatRateBp);
    return { netCents: split.netCents, vatCents: split.vatCents, grossCents };
  }
  // Irraggiungibile passando dallo schema, che pretende almeno uno dei due.
  throw new Error('resolveAmount richiede almeno uno fra netCents e grossCents');
}

const expenseBaseSchema = z.strictObject({
  name: nameSchema,
  description: optionalText(z.string().trim().max(500)).default(null),

  vendorId: relationIdSchema.default(null),
  categoryId: relationIdSchema.default(null),
  paymentMethodId: relationIdSchema.default(null),
  clientId: relationIdSchema.default(null),

  ...amountFields,
  currency: currencySchema.default('EUR'),

  recurrenceUnit: recurrenceUnitSchema.default('MONTH'),
  recurrenceInterval: z
    .number()
    .int()
    .min(1, 'L\u2019intervallo parte da 1')
    .max(365, 'Un intervallo oltre 365 non serve a nessuno')
    .default(1),
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullish().default(null),

  status: expenseStatusSchema.default('ACTIVE'),
  autoRenew: z.boolean().default(true),

  cancellationNoticeDays: z
    .number()
    .int()
    .min(0)
    .max(730, 'Un preavviso oltre due anni non è un preavviso')
    .nullish()
    .default(null),
  cancelledAt: z.coerce.date().nullish().default(null),

  rebillMode: rebillModeSchema.default('NONE'),
  rebillMarkupBp: z.number().int().min(0).max(1_000_000).nullish().default(null),
  rebillAmountCents: amountCentsSchema.nullish().default(null),

  notes: notesSchema.default(null),
});

/**
 * Quello che di una spesa può decidere l'utente.
 *
 * Le regole incrociate stanno in un `superRefine` e non nei singoli campi
 * perché parlano di coppie: nessuna delle due metà da sola è sbagliata, è la
 * combinazione a non stare in piedi. Il messaggio indica sempre il campo che
 * l'utente deve toccare, non quello che ha fatto scattare il controllo.
 */
export const expenseInputSchema = expenseBaseSchema
  .superRefine((value, ctx) => {
    if (value.netCents == null && value.grossCents == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['grossCents'],
        message: 'Serve almeno uno fra imponibile e totale',
      });
    }
    if (value.netCents != null && value.grossCents != null && value.grossCents < value.netCents) {
      ctx.addIssue({
        code: 'custom',
        path: ['grossCents'],
        message: 'Il totale non può essere minore dell\u2019imponibile',
      });
    }

    if (value.recurrenceUnit === 'ONE_OFF') {
      if (value.recurrenceInterval !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['recurrenceInterval'],
          message: 'Una spesa una tantum non ha un intervallo',
        });
      }
      if (value.endDate != null) {
        ctx.addIssue({
          code: 'custom',
          path: ['endDate'],
          message: 'Una spesa una tantum non ha una data di fine: è già finita',
        });
      }
      if (value.cancellationNoticeDays != null) {
        ctx.addIssue({
          code: 'custom',
          path: ['cancellationNoticeDays'],
          message: 'Una spesa una tantum non si disdice: non si rinnova',
        });
      }
    }

    if (value.endDate != null && value.endDate < value.startDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'La data di fine precede quella di inizio',
      });
    }

    // Riaddebitare significa rimettere il costo in conto a qualcuno: senza
    // cliente il riaddebito non ha destinatario, e il margine per cliente non
    // avrebbe dove sommarlo.
    if (value.rebillMode !== 'NONE' && value.clientId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['clientId'],
        message: 'Un riaddebito ha bisogno del cliente a cui viene riaddebitato',
      });
    }

    if (value.rebillMode === 'MARKUP' && value.rebillMarkupBp == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['rebillMarkupBp'],
        message: 'Il riaddebito con ricarico ha bisogno della percentuale',
      });
    }
    if (value.rebillMode !== 'MARKUP' && value.rebillMarkupBp != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['rebillMarkupBp'],
        message: 'Il ricarico vale solo con il riaddebito con ricarico',
      });
    }
    if (value.rebillMode === 'FIXED' && value.rebillAmountCents == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['rebillAmountCents'],
        message: 'Il riaddebito a forfait ha bisogno dell\u2019importo concordato',
      });
    }
    if (value.rebillMode !== 'FIXED' && value.rebillAmountCents != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['rebillAmountCents'],
        message: 'L\u2019importo concordato vale solo con il riaddebito a forfait',
      });
    }
  })
  // Il netto e il lordo escono sempre valorizzati entrambi, così chi scrive
  // sul database non deve ricordarsi di completarli e non può completarli in
  // modo diverso da qui.
  .transform((value) => ({ ...value, ...resolveAmount(value) }));

export type ExpenseInput = z.infer<typeof expenseInputSchema>;
export type ExpenseFormInput = z.input<typeof expenseInputSchema>;

/**
 * Quanto viene riaddebitato al cliente per un'occorrenza.
 *
 * In forfettario l'IVA sulle passive non è detraibile, quindi il costo vero è
 * il lordo: è quello che si rimette in conto, non l'imponibile. `null` quando
 * non c'è riaddebito, che è diverso da zero — zero vorrebbe dire «riaddebitato
 * gratis», e non è la stessa informazione.
 */
export function rebilledAmount(
  expense: {
    rebillMode: RebillMode;
    rebillMarkupBp: number | null;
    rebillAmountCents: number | null;
  },
  grossCents: number,
): number | null {
  switch (expense.rebillMode) {
    case 'NONE':
      return null;
    case 'PASSTHROUGH':
      return grossCents;
    case 'MARKUP':
      return grossCents + applyBasisPoints(grossCents, expense.rebillMarkupBp ?? 0);
    case 'FIXED':
      return expense.rebillAmountCents;
  }
}

export interface Expense {
  id: string;
  name: string;
  description: string | null;

  vendorId: string | null;
  categoryId: string | null;
  paymentMethodId: string | null;
  clientId: string | null;
  /** Nomi delle relazioni, per non dover chiedere quattro elenchi per disegnare una riga. */
  vendorName: string | null;
  categoryName: string | null;
  paymentMethodLabel: string | null;
  clientName: string | null;

  netCents: number;
  vatRateBp: number;
  grossCents: number;
  currency: string;

  recurrenceUnit: z.infer<typeof recurrenceUnitSchema>;
  recurrenceInterval: number;
  /** `2027-03-15`: un giorno di calendario, non un istante. */
  startDate: string;
  endDate: string | null;

  status: ExpenseStatus;
  autoRenew: boolean;
  cancellationNoticeDays: number | null;
  cancelledAt: string | null;

  rebillMode: RebillMode;
  rebillMarkupBp: number | null;
  rebillAmountCents: number | null;

  notes: string | null;
  createdAt: string;
  updatedAt: string;

  /** Prossima scadenza non ancora pagata, se ce n'è una entro l'orizzonte. */
  nextDueDate: string | null;
  /** Ultimo giorno utile per disdire prima di quella scadenza. */
  nextCancellationDeadline: string | null;
  occurrenceCount: number;
}

export interface ExpenseOccurrence {
  id: string;
  expenseId: string;
  expenseName: string;
  dueDate: string;
  periodStart: string | null;
  periodEnd: string | null;

  netCents: number;
  vatRateBp: number;
  grossCents: number;
  currency: string;
  fxRate: string | null;
  baseGrossCents: number;

  status: OccurrenceStatus;
  paidAt: string | null;
  confirmedAt: string | null;
  documentId: string | null;
  notes: string | null;
}

export const EXPENSE_SORT_FIELDS = ['name', 'startDate', 'grossCents', 'createdAt'] as const;

/**
 * Filtri dell'elenco delle spese.
 *
 * `archived` non c'è: una spesa non si archivia, cambia stato, e i quattro
 * stati non si riducono a un booleano. Il filtro predefinito mostra tutto
 * perché una spesa disdetta il mese scorso è ancora la risposta a «quanto
 * pagavo per questo servizio».
 */
export const expenseListQuerySchema = buildListQuerySchema(EXPENSE_SORT_FIELDS, 'name')
  .omit({ archived: true })
  .extend({
    status: expenseStatusSchema.optional(),
    vendorId: z.string().trim().optional(),
    categoryId: z.string().trim().optional(),
    clientId: z.string().trim().optional(),
    /** Solo le spese che hanno una scadenza in questa finestra. */
    dueFrom: isoDateSchema.optional(),
    dueTo: isoDateSchema.optional(),
  });

export type ExpenseListQuery = z.infer<typeof expenseListQuerySchema>;

export const OCCURRENCE_SORT_FIELDS = ['dueDate', 'grossCents'] as const;

export const occurrenceListQuerySchema = buildListQuerySchema(OCCURRENCE_SORT_FIELDS, 'dueDate')
  .omit({ archived: true })
  .extend({
    expenseId: z.string().trim().optional(),
    status: occurrenceStatusSchema.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    /** Solo quelle marcate pagate dal cron ma non ancora verificate da una persona. */
    unconfirmed: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  });

export type OccurrenceListQuery = z.infer<typeof occurrenceListQuerySchema>;

/**
 * La modifica di una singola occorrenza.
 *
 * È una `PATCH` e non una `PUT`, contro la convenzione delle altre risorse: le
 * occorrenze non le scrive l'utente, le genera il motore. Mandare l'oggetto
 * intero significherebbe rispedire indietro campi che nessuno ha inteso
 * toccare — la data di scadenza, il periodo coperto — e un giorno riscriverli
 * per sbaglio.
 *
 * La correzione dell'importo c'è di proposito: accorgersi che il fornitore ha
 * aumentato il prezzo è uno dei motivi per cui l'applicazione esiste, e
 * accorgersene senza poter correggere la cifra sarebbe metà lavoro.
 */
export const occurrencePatchSchema = z.strictObject({
  status: occurrenceStatusSchema.optional(),
  paidAt: z.coerce.date().nullish(),
  /** `true` marca l'occorrenza come verificata da una persona; `false` la rimette in dubbio. */
  confirmed: z.boolean().optional(),
  documentId: relationIdSchema.optional(),
  netCents: amountCentsSchema.nullish(),
  grossCents: amountCentsSchema.nullish(),
  vatRateBp: vatRateBpSchema.optional(),
  notes: notesSchema.optional(),
});

export type OccurrencePatch = z.infer<typeof occurrencePatchSchema>;
