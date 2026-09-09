import {
  type ExpenseOccurrence,
  type OccurrencePatch,
  formatIsoDate,
  occurrenceListQuerySchema,
  occurrencePatchSchema,
  resolveAmount,
} from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { Prisma } from '../generated/prisma/client';
import { idParamSchema, notFound, pageWindow, paginate } from '../lib/resources';
import { parseBody, parseQuery } from '../lib/validation';
import { requireUser } from '../plugins/auth';
import { applyRate } from '../services/fx';

/**
 * Le singole scadenze.
 *
 * Non si creano e non si cancellano da qui: le genera il motore a partire dalla
 * spesa, e una riga inserita a mano tornerebbe a sparire alla prima
 * sincronizzazione. Quello che si fa è correggerle — marcarne una pagata,
 * saltarne una, aggiustare un importo che il fornitore ha alzato senza dirlo.
 */

const SELECT = {
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
  documentId: true,
  notes: true,
  expense: { select: { name: true } },
} satisfies Prisma.ExpenseOccurrenceSelect;

type OccurrenceRow = Prisma.ExpenseOccurrenceGetPayload<{ select: typeof SELECT }>;

function toOccurrence(row: OccurrenceRow): ExpenseOccurrence {
  return {
    id: row.id,
    expenseId: row.expenseId,
    expenseName: row.expense.name,
    dueDate: formatIsoDate(row.dueDate),
    periodStart: row.periodStart === null ? null : formatIsoDate(row.periodStart),
    periodEnd: row.periodEnd === null ? null : formatIsoDate(row.periodEnd),

    netCents: row.netCents,
    vatRateBp: row.vatRateBp,
    grossCents: row.grossCents,
    currency: row.currency,
    // Il cambio esce come stringa e non come numero: ha dieci decimali, e
    // farlo passare da un `number` in JSON significherebbe riconsegnarlo
    // arrotondato a chi lo legge.
    fxRate: row.fxRate?.toString() ?? null,
    baseGrossCents: row.baseGrossCents,

    status: row.status,
    paidAt: row.paidAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    documentId: row.documentId,
    notes: row.notes,
  };
}

export function registerOccurrenceRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: app.authenticate };

  app.get('/occurrences', guarded, async (request, reply) => {
    const user = requireUser(request);
    const query = parseQuery(occurrenceListQuerySchema, request.query);

    const where = {
      userId: user.id,
      ...(query.expenseId === undefined ? {} : { expenseId: query.expenseId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            dueDate: {
              ...(query.from === undefined ? {} : { gte: query.from }),
              ...(query.to === undefined ? {} : { lte: query.to }),
            },
          }),
      // «Da confermare» sono quelle che il cron ha dato per pagate senza che
      // nessuno abbia guardato: è la lista da cui ci si accorge di un aumento
      // di prezzo, e senza questo filtro sarebbe indistinguibile dal resto.
      ...(query.unconfirmed ? { status: 'PAID' as const, confirmedAt: null } : {}),
      ...(query.q === undefined
        ? {}
        : { expense: { name: { contains: query.q, mode: 'insensitive' as const } } }),
    } satisfies Prisma.ExpenseOccurrenceWhereInput;

    const [rows, total] = await Promise.all([
      app.prisma.expenseOccurrence.findMany({
        where,
        select: SELECT,
        orderBy: [{ [query.sort]: query.direction }, { id: 'asc' }],
        ...pageWindow(query.page, query.perPage),
      }),
      app.prisma.expenseOccurrence.count({ where }),
    ]);

    return reply.send(paginate(rows.map(toOccurrence), total, query.page, query.perPage));
  });

  app.get('/occurrences/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const row = await app.prisma.expenseOccurrence.findFirst({
      where: { id, userId: user.id },
      select: SELECT,
    });
    if (row === null) throw notFound('Scadenza');

    return reply.send(toOccurrence(row));
  });

  /**
   * Corregge una scadenza.
   *
   * `PATCH` e non `PUT`: il corpo contiene solo ciò che si vuole cambiare, e
   * un campo assente resta com'è. Con una `PUT` il client dovrebbe rispedire
   * anche la data di scadenza e il periodo coperto, che non sono suoi.
   */
  app.patch('/occurrences/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    const patch = parseBody(occurrencePatchSchema, request.body);

    const current = await app.prisma.expenseOccurrence.findFirst({
      where: { id, userId: user.id },
      select: {
        netCents: true,
        vatRateBp: true,
        grossCents: true,
        currency: true,
        fxRate: true,
        status: true,
      },
    });
    if (current === null) throw notFound('Scadenza');

    if (patch.documentId != null) {
      const owned = await app.prisma.document.count({
        where: { id: patch.documentId, userId: user.id },
      });
      if (owned === 0) throw notFound('Documento');
    }

    const row = await app.prisma.expenseOccurrence.update({
      where: { id, userId: user.id },
      data: buildPatch(patch, current),
      select: SELECT,
    });
    return reply.send(toOccurrence(row));
  });
}

/**
 * Traduce la correzione in colonne, ricalcolando solo ciò che dipende.
 *
 * Tre cose valgono la pena di essere dette. La prima: correggere l'importo
 * rifà anche il convertito, perché lasciare `baseGrossCents` al valore vecchio
 * produrrebbe una riga che si contraddice da sola. Il cambio resta quello
 * congelato — è il tasso del giorno in cui la scadenza è maturata, e correggere
 * la cifra non cambia il giorno.
 *
 * La seconda: marcare pagata senza dire quando mette la data di scadenza come
 * data di pagamento. È l'ipotesi giusta nella grande maggioranza dei casi, e
 * lasciare `paidAt` vuoto renderebbe impossibile ordinare per data di
 * pagamento.
 *
 * La terza: `confirmed` è un booleano in ingresso e un istante in tabella.
 * Serve sapere *quando* è stata verificata, ma chi la verifica sta guardando
 * una casella da spuntare, non un calendario.
 */
function buildPatch(
  patch: OccurrencePatch,
  current: {
    netCents: number;
    vatRateBp: number;
    grossCents: number;
    fxRate: { toString: () => string } | null;
    status: string;
  },
): Prisma.ExpenseOccurrenceUncheckedUpdateInput {
  const data: Prisma.ExpenseOccurrenceUncheckedUpdateInput = {};

  if (patch.netCents != null || patch.grossCents != null || patch.vatRateBp !== undefined) {
    const vatRateBp = patch.vatRateBp ?? current.vatRateBp;
    // Cambiare la sola aliquota tiene fermo l'imponibile e rifà il totale: è
    // l'imponibile il dato che si è letto sulla fattura, l'altro è un conto.
    const amount =
      patch.netCents == null && patch.grossCents == null
        ? resolveAmount({ netCents: current.netCents, vatRateBp })
        : resolveAmount({ netCents: patch.netCents, grossCents: patch.grossCents, vatRateBp });

    data.netCents = amount.netCents;
    data.grossCents = amount.grossCents;
    data.vatRateBp = vatRateBp;
    // Il cambio resta quello congelato: è il tasso del giorno in cui la
    // scadenza è maturata, e correggere la cifra non cambia il giorno.
    data.baseGrossCents = applyRate(amount.grossCents, current.fxRate?.toString() ?? null);
  }

  if (patch.status !== undefined) {
    data.status = patch.status;
    if (patch.status !== 'PAID') data.paidAt = null;
  }
  if (patch.paidAt !== undefined) data.paidAt = patch.paidAt;

  const becomesPaid = patch.status === 'PAID' && current.status !== 'PAID';
  if (becomesPaid && patch.paidAt == null) data.paidAt = new Date();

  if (patch.confirmed !== undefined) data.confirmedAt = patch.confirmed ? new Date() : null;
  if (patch.documentId !== undefined) data.documentId = patch.documentId;
  if (patch.notes !== undefined) data.notes = patch.notes;

  return data;
}
