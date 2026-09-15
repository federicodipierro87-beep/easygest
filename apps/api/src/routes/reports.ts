import {
  LEDGER_MAX_ROWS,
  type ReportRow,
  type ReportSummary,
  foldReport,
  formatIsoDate,
  rebillGrossCents,
  reportQuerySchema,
} from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { Prisma } from '../generated/prisma/client';
import { parseQuery } from '../lib/validation';
import { requireUser } from '../plugins/auth';
import { applyRate } from '../services/fx';

/**
 * I report per periodo, e il dettaglio da cui nascono.
 *
 * Due rotte sopra **la stessa query e le stesse righe**: `GET /reports` piega
 * e restituisce gli aggregati, `GET /reports/ledger` restituisce le righe
 * intere, che diventano il CSV. Non è una ripetizione da eliminare: è la
 * ragione per cui chi somma la colonna del CSV in Excel ottiene il numero che
 * legge a schermo. Se le due rotte leggessero insiemi diversi, la differenza
 * si scoprirebbe in fondo a un foglio di calcolo, mesi dopo.
 *
 * L'aggregazione non passa dal database. `categoryId`, `vendorId` e `clientId`
 * stanno su `Expense` e non sull'occorrenza, quindi un `groupBy` di Prisma non
 * li raggiunge; un `$queryRaw` li raggiungerebbe, ma costringerebbe a
 * riscrivere a mano lo scoping su `userId` in ogni query — cioè il punto esatto
 * in cui una dimenticanza diventa una fuga di dati fra utenti. Resta una
 * `findMany` stretta e una piega pura in `shared`.
 */

const LEDGER_SELECT = {
  id: true,
  expenseId: true,
  dueDate: true,
  periodStart: true,
  periodEnd: true,
  netCents: true,
  vatRateBp: true,
  grossCents: true,
  currency: true,
  fxRate: true,
  baseGrossCents: true,
  status: true,
  paidAt: true,
  confirmedAt: true,
  expense: {
    select: {
      name: true,
      categoryId: true,
      vendorId: true,
      clientId: true,
      rebillMode: true,
      rebillMarkupBp: true,
      rebillAmountCents: true,
      category: { select: { name: true } },
      vendor: { select: { name: true } },
      client: { select: { name: true } },
    },
  },
} satisfies Prisma.ExpenseOccurrenceSelect;

type LedgerPayload = Prisma.ExpenseOccurrenceGetPayload<{ select: typeof LEDGER_SELECT }>;

/** Una data nullable come giorno di calendario, o niente. */
function day(value: Date | null): string | null {
  return value === null ? null : formatIsoDate(value);
}

function toReportRow(row: LedgerPayload): ReportRow {
  /**
   * Il cambio resta una stringa a dieci decimali, com'è in `Decimal(20,10)`.
   *
   * Portarlo a `number` perderebbe cifre sui cambi grandi, e nel CSV è una
   * colonna di tracciabilità: deve essere quello che c'è in tabella, non una
   * sua approssimazione. `applyRate` infatti vuole proprio la stringa.
   */
  const fxRate = row.fxRate === null ? null : row.fxRate.toString();

  /**
   * Il riaddebito si calcola in due passaggi perché vive in due mondi.
   *
   * `rebillGrossCents` applica le regole della spesa nella **valuta della
   * spesa**, ed è puro: sta in `shared` insieme alle altre regole di spesa.
   * Portarlo in valuta base richiede `applyRate`, che usa `Prisma.Decimal` e
   * quindi non può attraversare quel confine. Il cambio è quello congelato
   * sull'occorrenza, non quello di oggi: altrimenti i margini storici
   * cambierebbero da soli tutte le mattine.
   */
  const rebillBaseCents = applyRate(rebillGrossCents(row.expense, row.grossCents), fxRate);

  return {
    occurrenceId: row.id,
    expenseId: row.expenseId,
    expenseName: row.expense.name,
    dueDate: formatIsoDate(row.dueDate),
    periodStart: day(row.periodStart),
    periodEnd: day(row.periodEnd),
    netCents: row.netCents,
    vatRateBp: row.vatRateBp,
    grossCents: row.grossCents,
    currency: row.currency,
    fxRate,
    baseGrossCents: row.baseGrossCents,
    status: row.status,
    paidAt: day(row.paidAt),
    confirmedAt: day(row.confirmedAt),
    categoryId: row.expense.categoryId,
    categoryName: row.expense.category?.name ?? null,
    vendorId: row.expense.vendorId,
    vendorName: row.expense.vendor?.name ?? null,
    clientId: row.expense.clientId,
    clientName: row.expense.client?.name ?? null,
    rebillBaseCents,
  };
}

export function registerReportRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: app.authenticate };

  /**
   * Le righe del periodo, ordinate e già appiattite.
   *
   * `userId` sta nel `where` dell'occorrenza e non solo in quello della spesa:
   * la colonna è denormalizzata apposta, e passare dalla relazione
   * costerebbe un join per ottenere la stessa garanzia in modo più fragile.
   */
  async function ledger(userId: string, from: Date, to: Date, take?: number): Promise<ReportRow[]> {
    const rows = await app.prisma.expenseOccurrence.findMany({
      where: { userId, dueDate: { gte: from, lte: to } },
      // `id` come secondo criterio: con un tetto sulle righe, l'ordine fra due
      // scadenze dello stesso giorno smette di essere un dettaglio estetico.
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      ...(take === undefined ? {} : { take }),
      select: LEDGER_SELECT,
    });
    return rows.map(toReportRow);
  }

  app.get('/reports', guarded, async (request) => {
    const user = requireUser(request);
    const { from, to } = parseQuery(reportQuerySchema, request.query);

    const settings = await app.prisma.settings.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
      select: { baseCurrency: true },
    });

    /**
     * Il riepilogo non ha tetto sulle righe, a differenza del dettaglio.
     *
     * Un totale calcolato sulle prime cinquemila righe sarebbe un numero
     * sbagliato che sembra giusto — il difetto peggiore che un report possa
     * avere. Quello che difende questa query è il tetto di tre anni sul
     * periodo, che sta nello schema e vale per entrambe le rotte.
     */
    const rows = await ledger(user.id, from, to);

    const summary: ReportSummary = foldReport(rows, {
      from,
      to,
      baseCurrency: settings.baseCurrency,
    });
    return summary;
  });

  /**
   * Il dettaglio, per il CSV.
   *
   * Si chiede una riga in più del massimo per sapere se ce n'erano altre. Un
   * file tagliato in silenzio è peggio di nessun file: chi lo apre somma una
   * colonna incompleta e non ha modo di accorgersene, quindi `truncated`
   * arriva fino al browser e blocca il download.
   */
  app.get('/reports/ledger', guarded, async (request) => {
    const user = requireUser(request);
    const { from, to } = parseQuery(reportQuerySchema, request.query);

    const rows = await ledger(user.id, from, to, LEDGER_MAX_ROWS + 1);
    const truncated = rows.length > LEDGER_MAX_ROWS;

    return { rows: truncated ? rows.slice(0, LEDGER_MAX_ROWS) : rows, truncated };
  });
}
