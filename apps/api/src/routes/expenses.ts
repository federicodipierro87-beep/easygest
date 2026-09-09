import {
  EXPENSE_ERROR_CODES,
  type Expense,
  type ExpenseInput,
  cancellationDeadline,
  expenseInputSchema,
  expenseListQuerySchema,
  formatIsoDate,
} from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { Prisma, PrismaClient } from '../generated/prisma/client';
import {
  ResourceError,
  idParamSchema,
  isRecordNotFound,
  notFound,
  pageWindow,
  paginate,
} from '../lib/resources';
import { parseBody, parseQuery } from '../lib/validation';
import { requireUser } from '../plugins/auth';
import { occurrenceContext, syncOccurrences } from '../services/occurrences';

/**
 * Le spese, cioè i contratti; le singole scadenze stanno in `occurrences.ts`.
 *
 * La differenza con le anagrafiche è che scrivere qui non finisce con la
 * scrittura: ogni creazione e ogni modifica rimettono in riga le occorrenze
 * future, perché una spesa senza le sue scadenze non compare da nessuna parte —
 * né nel calendario, né nelle previsioni, né nei report.
 */

const SELECT = {
  id: true,
  name: true,
  description: true,
  vendorId: true,
  categoryId: true,
  paymentMethodId: true,
  clientId: true,
  netCents: true,
  vatRateBp: true,
  grossCents: true,
  currency: true,
  recurrenceUnit: true,
  recurrenceInterval: true,
  startDate: true,
  endDate: true,
  status: true,
  autoRenew: true,
  cancellationNoticeDays: true,
  cancelledAt: true,
  rebillMode: true,
  rebillMarkupBp: true,
  rebillAmountCents: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  vendor: { select: { name: true } },
  category: { select: { name: true } },
  paymentMethod: { select: { label: true } },
  client: { select: { name: true } },
  _count: { select: { occurrences: true } },
} satisfies Prisma.ExpenseSelect;

/**
 * La prossima scadenza da pagare, una riga per spesa.
 *
 * `take: 1` dentro una relazione non è una scorciatoia che Prisma traduce in
 * una query per riga: diventa una finestra sola su tutta la pagina. Senza,
 * l'elenco delle spese farebbe una query per ogni riga solo per scrivere una
 * data in fondo alla colonna.
 */
function nextDueSelect(today: Date): Prisma.Expense$occurrencesArgs {
  return {
    where: { status: 'PLANNED', dueDate: { gte: today } },
    orderBy: { dueDate: 'asc' },
    take: 1,
    select: { dueDate: true },
  };
}

type ExpenseRow = Prisma.ExpenseGetPayload<{ select: typeof SELECT }> & {
  occurrences?: { dueDate: Date }[];
};

function toExpense(row: ExpenseRow): Expense {
  const nextDue = row.occurrences?.[0]?.dueDate ?? null;

  return {
    id: row.id,
    name: row.name,
    description: row.description,

    vendorId: row.vendorId,
    categoryId: row.categoryId,
    paymentMethodId: row.paymentMethodId,
    clientId: row.clientId,
    vendorName: row.vendor?.name ?? null,
    categoryName: row.category?.name ?? null,
    paymentMethodLabel: row.paymentMethod?.label ?? null,
    clientName: row.client?.name ?? null,

    netCents: row.netCents,
    vatRateBp: row.vatRateBp,
    grossCents: row.grossCents,
    currency: row.currency,

    recurrenceUnit: row.recurrenceUnit,
    recurrenceInterval: row.recurrenceInterval,
    // Un giorno di calendario esce come `2027-03-15` e non come istante ISO:
    // scritto per intero, la stessa data letta a Roma d'estate diventerebbe il
    // 15 alle 02:00, e a Los Angeles il 14.
    startDate: formatIsoDate(row.startDate),
    endDate: row.endDate === null ? null : formatIsoDate(row.endDate),

    status: row.status,
    autoRenew: row.autoRenew,
    cancellationNoticeDays: row.cancellationNoticeDays,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,

    rebillMode: row.rebillMode,
    rebillMarkupBp: row.rebillMarkupBp,
    rebillAmountCents: row.rebillAmountCents,

    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),

    nextDueDate: nextDue === null ? null : formatIsoDate(nextDue),
    // La scadenza che conta davvero non è il rinnovo ma l'ultimo giorno per
    // disdirlo: il calcolo sta in `shared` perché lo rifà identico il cron che
    // manda i promemoria.
    nextCancellationDeadline:
      nextDue === null
        ? null
        : formatIsoDateOrNull(cancellationDeadline(nextDue, row.cancellationNoticeDays)),
    occurrenceCount: row._count.occurrences,
  };
}

function formatIsoDateOrNull(date: Date | null): string | null {
  return date === null ? null : formatIsoDate(date);
}

/**
 * Verifica che le relazioni indicate siano dell'utente che sta scrivendo.
 *
 * Prisma da solo controlla che l'identificativo esista, non che sia di chi lo
 * sta usando: senza questo passaggio si potrebbe attribuire una spesa al
 * cliente di un altro, e l'errore verrebbe fuori mesi dopo da un report.
 *
 * Le quattro verifiche partono insieme perché sono indipendenti fra loro.
 */
async function assertRelationsOwned(
  prisma: PrismaClient,
  userId: string,
  input: Pick<ExpenseInput, 'vendorId' | 'categoryId' | 'paymentMethodId' | 'clientId'>,
): Promise<void> {
  const checks = await Promise.all([
    count(input.vendorId, (id) => prisma.vendor.count({ where: { id, userId } })),
    count(input.categoryId, (id) => prisma.category.count({ where: { id, userId } })),
    count(input.paymentMethodId, (id) => prisma.paymentMethod.count({ where: { id, userId } })),
    count(input.clientId, (id) => prisma.client.count({ where: { id, userId } })),
  ]);

  const fields = ['vendorId', 'categoryId', 'paymentMethodId', 'clientId'] as const;
  const unknown = fields.filter((_, index) => checks[index] === false);
  if (unknown.length === 0) return;

  throw new ResourceError(
    422,
    EXPENSE_ERROR_CODES.unknownRelation,
    'Alcuni collegamenti indicati non esistono',
    { fields: unknown },
  );
}

/** `true` anche quando non c'è niente da verificare: nessun collegamento è valido. */
async function count(id: string | null, query: (id: string) => Promise<number>): Promise<boolean> {
  if (id === null) return true;
  return (await query(id)) > 0;
}

export function registerExpenseRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: app.authenticate };

  app.get('/expenses', guarded, async (request, reply) => {
    const user = requireUser(request);
    const query = parseQuery(expenseListQuerySchema, request.query);
    const { today } = await occurrenceContext(app.prisma, user.id);

    const where = {
      userId: user.id,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.vendorId === undefined ? {} : { vendorId: query.vendorId }),
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      ...(query.clientId === undefined ? {} : { clientId: query.clientId }),
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { description: { contains: query.q, mode: 'insensitive' } },
              { vendor: { name: { contains: query.q, mode: 'insensitive' } } },
            ],
          }),
      // Il filtro per finestra guarda le occorrenze, non le date della spesa:
      // «cosa scade a marzo» non è «cosa è iniziato a marzo».
      ...(query.dueFrom === undefined && query.dueTo === undefined
        ? {}
        : {
            occurrences: {
              some: {
                dueDate: {
                  ...(query.dueFrom === undefined ? {} : { gte: query.dueFrom }),
                  ...(query.dueTo === undefined ? {} : { lte: query.dueTo }),
                },
              },
            },
          }),
    } satisfies Prisma.ExpenseWhereInput;

    const [rows, total] = await Promise.all([
      app.prisma.expense.findMany({
        where,
        select: { ...SELECT, occurrences: nextDueSelect(today) },
        orderBy: [{ [query.sort]: query.direction }, { id: 'asc' }],
        ...pageWindow(query.page, query.perPage),
      }),
      app.prisma.expense.count({ where }),
    ]);

    return reply.send(paginate(rows.map(toExpense), total, query.page, query.perPage));
  });

  app.get('/expenses/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    const { today } = await occurrenceContext(app.prisma, user.id);

    const row = await app.prisma.expense.findFirst({
      where: { id, userId: user.id },
      select: { ...SELECT, occurrences: nextDueSelect(today) },
    });
    if (row === null) throw notFound('Spesa');

    return reply.send(toExpense(row));
  });

  /**
   * Crea la spesa e insieme le sue scadenze.
   *
   * Se mancasse il cambio per convertirla, `syncOccurrences` solleva un 422 e
   * la spesa resta creata ma senza occorrenze. È voluto: la spesa è un dato
   * valido, e cancellarla per un tasso mancante costringerebbe a reinserirla
   * tutta dopo aver sincronizzato i cambi.
   */
  app.post('/expenses', guarded, async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(expenseInputSchema, request.body);
    await assertRelationsOwned(app.prisma, user.id, input);

    const context = await occurrenceContext(app.prisma, user.id);
    const created = await app.prisma.expense.create({
      data: { ...toData(input), userId: user.id },
    });
    await syncOccurrences(app.prisma, created, context);

    const row = await app.prisma.expense.findUniqueOrThrow({
      where: { id: created.id },
      select: { ...SELECT, occurrences: nextDueSelect(context.today) },
    });
    return reply.status(201).send(toExpense(row));
  });

  app.put('/expenses/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    const input = parseBody(expenseInputSchema, request.body);
    await assertRelationsOwned(app.prisma, user.id, input);

    const context = await occurrenceContext(app.prisma, user.id);
    let updated;
    try {
      updated = await app.prisma.expense.update({
        where: { id, userId: user.id },
        data: toData(input),
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw notFound('Spesa');
      throw error;
    }

    await syncOccurrences(app.prisma, updated, context);

    const row = await app.prisma.expense.findUniqueOrThrow({
      where: { id: updated.id },
      select: { ...SELECT, occurrences: nextDueSelect(context.today) },
    });
    return reply.send(toExpense(row));
  });

  /**
   * Cancella la spesa, ma solo se non ha lasciato tracce.
   *
   * Le occorrenze cadono con lei — `onDelete: Cascade` — e con loro sparirebbe
   * quanto è stato pagato. Una spesa che ha storico si porta a `ENDED` o
   * `CANCELLED`: smette di produrre scadenze e resta nei report. Si cancella
   * solo quella inserita per sbaglio, cioè quella che ha ancora soltanto
   * previsioni.
   */
  app.delete('/expenses/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const existing = await app.prisma.expense.findFirst({
      where: { id, userId: user.id },
      select: {
        name: true,
        _count: { select: { occurrences: { where: { status: { not: 'PLANNED' } } } } },
      },
    });
    if (existing === null) throw notFound('Spesa');

    const settled = existing._count.occurrences;
    if (settled > 0) {
      throw new ResourceError(
        409,
        'RESOURCE_IN_USE',
        `La spesa «${existing.name}» ha ${String(settled)} scadenze già registrate e non si può cancellare. Portala a «Conclusa» per fermarla senza perdere lo storico.`,
        { occurrences: settled },
      );
    }

    await app.prisma.expense.delete({ where: { id, userId: user.id } });
    return reply.status(204).send();
  });
}

/**
 * Dallo schema alla riga, campo per campo.
 *
 * Elencati invece che sparsi con uno spread: la validazione produce anche
 * `vatCents`, che una colonna non ce l'ha — è la differenza fra gli altri due,
 * e persisterlo significherebbe poterlo contraddire. Scritti a mano, il giorno
 * in cui lo schema guadagna un campo il compilatore non dice niente ma nemmeno
 * scrive di nascosto qualcosa che nessuno ha inteso salvare.
 */
function toData(input: ExpenseInput): Omit<Prisma.ExpenseUncheckedCreateInput, 'userId'> {
  return {
    name: input.name,
    description: input.description,
    vendorId: input.vendorId,
    categoryId: input.categoryId,
    paymentMethodId: input.paymentMethodId,
    clientId: input.clientId,
    netCents: input.netCents,
    vatRateBp: input.vatRateBp,
    grossCents: input.grossCents,
    currency: input.currency,
    recurrenceUnit: input.recurrenceUnit,
    recurrenceInterval: input.recurrenceInterval,
    startDate: input.startDate,
    endDate: input.endDate,
    status: input.status,
    autoRenew: input.autoRenew,
    cancellationNoticeDays: input.cancellationNoticeDays,
    cancelledAt: input.cancelledAt,
    rebillMode: input.rebillMode,
    rebillMarkupBp: input.rebillMarkupBp,
    rebillAmountCents: input.rebillAmountCents,
    notes: input.notes,
  };
}
