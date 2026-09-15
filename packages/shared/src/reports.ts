import { z } from 'zod';

import type { OccurrenceStatus } from './expenses';
import { BP_SCALE, divideRoundHalfUp } from './money';
import { addMonths, differenceInDays, formatIsoDate, isoDateSchema } from './recurrence';

/**
 * I report per periodo: quanto è costato, a chi è andato, quanto se ne è
 * rimesso in conto.
 *
 * Il calcolo sta qui e non nel database per due motivi che si escludono a
 * vicenda con le alternative. Un `groupBy` di Prisma non funziona perché
 * `categoryId`, `vendorId` e `clientId` stanno su `Expense` e non su
 * `ExpenseOccurrence`: non sono raggruppabili senza passare dalla relazione.
 * Un `$queryRaw` funzionerebbe, ma costringerebbe a riscrivere a mano lo
 * scoping su `userId` in ogni query — cioè esattamente il punto in cui una
 * dimenticatura smette di essere un bug e diventa una fuga di dati fra utenti.
 *
 * Quindi: l'API fa una `findMany` stretta, costruisce le righe una volta sola,
 * e le piega qui. Che le stesse righe servano sia al riepilogo sia al CSV di
 * dettaglio non è un risparmio, è la garanzia che i due non possano divergere:
 * chi somma la colonna del CSV ottiene il numero che vede a schermo.
 */

/**
 * Il periodo più lungo che si può chiedere.
 *
 * Tre anni, cioè il tetto che rende `from=1970-01-01` una richiesta rifiutata
 * invece di una scansione dell'intera tabella. Qui non c'è paginazione: senza
 * un limite, l'unica difesa sarebbe la buona fede di chi compone l'URL.
 */
export const REPORT_MAX_DAYS = 1096;

/** Quante righe di dettaglio si restituiscono prima di dichiararsi tagliati. */
export const LEDGER_MAX_ROWS = 5000;

/**
 * `from` e `to` sono **obbligatori**, in deliberata divergenza da
 * `expenseListQuerySchema` dove sono opzionali.
 *
 * Un report senza periodo è una domanda senza senso, e un intervallo di
 * default nascosto nel codice produrrebbe numeri veri attribuiti al periodo
 * sbagliato: l'errore che non si vede, perché il risultato sembra plausibile.
 */
export const reportQuerySchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine(({ from, to }) => from <= to, {
    path: ['to'],
    message: 'La fine del periodo non può precedere l’inizio',
  })
  .refine(({ from, to }) => differenceInDays(from, to) <= REPORT_MAX_DAYS, {
    path: ['to'],
    message: 'Il periodo non può superare tre anni',
  });

export type ReportQuery = z.infer<typeof reportQuerySchema>;

/**
 * Una riga di dettaglio, già appiattita.
 *
 * Le date sono stringhe `YYYY-MM-DD` e non istanti: attraversano la rete verso
 * la pagina e verso il CSV, e un `Date` serializzato porterebbe con sé un
 * orario che il fuso del browser può spostare di un giorno.
 *
 * `fxRate` resta una stringa a dieci decimali, com'è in `Decimal(20,10)`.
 * Convertirlo in `number` significherebbe perdere cifre su cambi come lo yen,
 * e nel CSV è una colonna di tracciabilità: deve essere quello che c'è scritto
 * in tabella, non una sua approssimazione.
 *
 * `rebillBaseCents` arriva già convertito. `rebillGrossCents` lavora nella
 * valuta della spesa, e portarlo in valuta base richiede `applyRate`, che usa
 * `Prisma.Decimal` e quindi vive nell'API: qui si somma e basta.
 */
export interface ReportRow {
  occurrenceId: string;
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
  categoryId: string | null;
  categoryName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  clientId: string | null;
  clientName: string | null;
  rebillBaseCents: number;
}

export interface ReportBucket {
  /** `null` è il gruppo degli scoperti: senza categoria, senza fornitore. */
  id: string | null;
  label: string;
  totalCents: number;
  count: number;
  /**
   * Quota sul totale in punti base.
   *
   * **Le quote non sommano a 10 000.** Tre gruppi da un terzo danno 3333 tre
   * volte, cioè 9999: è arrotondamento, non un difetto. Per questo la pagina
   * non stampa mai un «totale 100 %», che sarebbe una bugia la metà delle
   * volte.
   */
  shareBp: number;
}

export interface ReportClientBucket extends ReportBucket {
  /** Quanto si rimette in conto, in valuta base. */
  rebillCents: number;
  /**
   * Riaddebito meno costo. È il margine **teorico**, quello che si ricava
   * dalle regole di riaddebito scritte sulla spesa.
   *
   * Quello effettivo — fatture attive emesse meno spese imputate — richiede le
   * rotte dei documenti, che non esistono: senza un modo di inserire le
   * fatture sarebbe una colonna di zeri con un nome che promette altro.
   */
  theoreticalMarginCents: number;
}

export interface ReportMonthBucket {
  /** `YYYY-MM`. */
  month: string;
  totalCents: number;
  count: number;
}

export interface ReportSummary {
  from: string;
  to: string;
  baseCurrency: string;
  totalCents: number;
  count: number;
  /** Quante righe erano in valuta diversa da quella base. */
  foreignCount: number;
  byCategory: ReportBucket[];
  byVendor: ReportBucket[];
  byClient: ReportClientBucket[];
  byMonth: ReportMonthBucket[];
}

/**
 * Il dettaglio, con la dichiarazione di essere completo o no.
 *
 * `truncated` non è un avviso da mostrare in un angolo: blocca il download.
 * Un CSV tagliato in silenzio è peggio di nessun CSV, perché chi lo apre somma
 * una colonna incompleta e non ha modo di accorgersene.
 */
export interface ReportLedger {
  rows: ReportRow[];
  truncated: boolean;
}

export const NO_CATEGORY_LABEL = 'Senza categoria';
export const NO_VENDOR_LABEL = 'Senza fornitore';
export const NO_CLIENT_LABEL = 'Non riaddebitata';

/**
 * Le righe che entrano nei totali.
 *
 * `SKIPPED` e `CANCELLED` restano fuori: sono scadenze che non sono costate
 * nulla. `PLANNED` entra invece — è un impegno preso, e un report che mostra
 * solo il pagato racconta il passato quando la domanda è «quanto mi costa
 * questo periodo».
 */
export function countsTowardReport(status: OccurrenceStatus): boolean {
  return status !== 'SKIPPED' && status !== 'CANCELLED';
}

/** `YYYY-MM` da un `YYYY-MM-DD`, senza costruire un `Date`. */
function monthOf(isoDay: string): string {
  return isoDay.slice(0, 7);
}

interface Accumulator {
  id: string | null;
  label: string;
  totalCents: number;
  count: number;
  rebillCents: number;
}

function bump(
  groups: Map<string, Accumulator>,
  id: string | null,
  name: string | null,
  fallback: string,
  row: ReportRow,
): void {
  // La chiave è l'id, non l'etichetta: due fornitori omonimi sono due
  // fornitori. Il gruppo degli scoperti ne ha una riservata, perché `null` non
  // è una chiave di `Map` distinguibile da una stringa vuota.
  const key = id ?? '\u0000senza';
  const existing = groups.get(key) ?? {
    id,
    label: id === null ? fallback : (name ?? fallback),
    totalCents: 0,
    count: 0,
    rebillCents: 0,
  };
  existing.totalCents += row.baseGrossCents;
  existing.count += 1;
  existing.rebillCents += row.rebillBaseCents;
  groups.set(key, existing);
}

/**
 * Ordine per totale decrescente, pareggi risolti per etichetta.
 *
 * Il secondo criterio non è estetica: senza, due chiamate identiche possono
 * restituire due ordini diversi, e la pagina sembrerebbe cambiare da sola a
 * ogni ricaricamento.
 */
function byTotalThenLabel(a: Accumulator, b: Accumulator): number {
  if (a.totalCents !== b.totalCents) return b.totalCents - a.totalCents;
  if (a.label === b.label) return 0;
  return a.label < b.label ? -1 : 1;
}

/**
 * La quota di un gruppo sul totale.
 *
 * Su un periodo vuoto il totale è zero, e `divideRoundHalfUp` su zero solleva:
 * la quota di niente è zero, non un errore da propagare fino alla pagina.
 */
function shareOf(totalCents: number, grandTotal: number): number {
  if (grandTotal === 0) return 0;
  return divideRoundHalfUp(totalCents * BP_SCALE, grandTotal);
}

function finish(groups: Map<string, Accumulator>, grandTotal: number): ReportBucket[] {
  return [...groups.values()].sort(byTotalThenLabel).map((group) => ({
    id: group.id,
    label: group.label,
    totalCents: group.totalCents,
    count: group.count,
    shareBp: shareOf(group.totalCents, grandTotal),
  }));
}

/**
 * Tutti i mesi del periodo, anche quelli senza righe.
 *
 * Saltare i mesi vuoti comprimerebbe la serie e nasconderebbe proprio
 * l'informazione che si cerca: un buco è un mese in cui non è stato pagato
 * nulla, e va visto.
 */
function monthsBetween(from: Date, to: Date): string[] {
  const months: string[] = [];
  const last = formatIsoDate(to).slice(0, 7);
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  let current = formatIsoDate(cursor).slice(0, 7);

  while (current <= last) {
    months.push(current);
    cursor = addMonths(cursor, 1);
    current = formatIsoDate(cursor).slice(0, 7);
  }

  return months;
}

/**
 * Le righe di un periodo ridotte ai numeri che si guardano.
 *
 * Pura e senza dipendenze dal database: è quello che la rende provabile senza
 * Postgres, ed è il motivo per cui le sei regole che seguono hanno un test
 * ciascuna invece di una verifica a occhio in produzione.
 *
 * Somma **solo `baseGrossCents`**. In forfettario l'IVA sulle passive è un
 * costo, quindi il lordo è il numero vero; e il cambio è congelato
 * sull'occorrenza, quindi non si riconverte mai niente — un report storico che
 * cambia perché è cambiato il cambio di oggi sarebbe inutilizzabile.
 *
 * I mesi si attribuiscono per `dueDate`. `periodStart`/`periodEnd`
 * permetterebbero di spalmare un dominio annuale su dodici mesi, ma è
 * un'aggregazione diversa con una sua ambiguità — il costo è di quando si paga
 * o di quando si consuma? — e va decisa quando servirà davvero, non adesso.
 */
export function foldReport(
  rows: readonly ReportRow[],
  options: { from: Date; to: Date; baseCurrency: string },
): ReportSummary {
  const categories = new Map<string, Accumulator>();
  const vendors = new Map<string, Accumulator>();
  const clients = new Map<string, Accumulator>();
  const months = new Map<string, ReportMonthBucket>();

  for (const month of monthsBetween(options.from, options.to)) {
    months.set(month, { month, totalCents: 0, count: 0 });
  }

  let totalCents = 0;
  let count = 0;
  let foreignCount = 0;

  for (const row of rows) {
    if (!countsTowardReport(row.status)) continue;

    totalCents += row.baseGrossCents;
    count += 1;
    if (row.currency !== options.baseCurrency) foreignCount += 1;

    bump(categories, row.categoryId, row.categoryName, NO_CATEGORY_LABEL, row);
    bump(vendors, row.vendorId, row.vendorName, NO_VENDOR_LABEL, row);
    bump(clients, row.clientId, row.clientName, NO_CLIENT_LABEL, row);

    // Una riga fuori dal periodo chiesto non inventa un mese in più: il
    // periodo lo decide chi chiama, e i mesi sono già tutti lì sopra.
    const bucket = months.get(monthOf(row.dueDate));
    if (bucket !== undefined) {
      bucket.totalCents += row.baseGrossCents;
      bucket.count += 1;
    }
  }

  return {
    from: formatIsoDate(options.from),
    to: formatIsoDate(options.to),
    baseCurrency: options.baseCurrency,
    totalCents,
    count,
    foreignCount,
    byCategory: finish(categories, totalCents),
    byVendor: finish(vendors, totalCents),
    byClient: [...clients.values()].sort(byTotalThenLabel).map((group) => ({
      id: group.id,
      label: group.label,
      totalCents: group.totalCents,
      count: group.count,
      shareBp: shareOf(group.totalCents, totalCents),
      rebillCents: group.rebillCents,
      theoreticalMarginCents: group.rebillCents - group.totalCents,
    })),
    byMonth: [...months.values()],
  };
}
