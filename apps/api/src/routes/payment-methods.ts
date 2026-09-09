import {
  type PaymentMethod,
  paymentMethodInputSchema,
  paymentMethodListQuerySchema,
} from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { PaymentMethod as PaymentMethodRecord, Prisma } from '../generated/prisma/client';
import {
  activeFilter,
  duplicateName,
  idParamSchema,
  inUse,
  isRecordNotFound,
  isUniqueViolation,
  notFound,
  pageWindow,
  paginate,
} from '../lib/resources';
import { parseBody, parseQuery } from '../lib/validation';
import { requireUser } from '../plugins/auth';

const SELECT = {
  id: true,
  label: true,
  type: true,
  last4: true,
  expiryMonth: true,
  expiryYear: true,
  notes: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  // Solo le spese: nessun documento punta a un metodo di pagamento. Il
  // conteggio dei documenti manca anche dalla risposta, invece di essere uno
  // zero costante che sembrerebbe un dato.
  _count: { select: { expenses: true } },
} satisfies Prisma.PaymentMethodSelect;

type PaymentMethodRow = Omit<PaymentMethodRecord, 'userId'> & {
  _count: { expenses: number };
};

function toPaymentMethod({
  _count,
  createdAt,
  updatedAt,
  ...rest
}: PaymentMethodRow): PaymentMethod {
  return {
    ...rest,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    expenseCount: _count.expenses,
  };
}

export function registerPaymentMethodRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: app.authenticate };

  app.get('/payment-methods', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { q, page, perPage, archived, sort, direction } = parseQuery(
      paymentMethodListQuerySchema,
      request.query,
    );

    const where = {
      userId: user.id,
      ...activeFilter(archived),
      // Le ultime quattro cifre sono un criterio di ricerca vero: si arriva
      // qui da una riga dell'estratto conto, dove il nome che hai dato tu alla
      // carta non compare da nessuna parte.
      ...(q === undefined
        ? {}
        : {
            OR: [
              { label: { contains: q, mode: 'insensitive' as const } },
              { last4: { contains: q } },
            ],
          }),
    } satisfies Prisma.PaymentMethodWhereInput;

    const [rows, total] = await Promise.all([
      app.prisma.paymentMethod.findMany({
        where,
        select: SELECT,
        orderBy: [{ [sort]: direction }, { id: 'asc' }],
        ...pageWindow(page, perPage),
      }),
      app.prisma.paymentMethod.count({ where }),
    ]);

    return reply.send(paginate(rows.map(toPaymentMethod), total, page, perPage));
  });

  app.get('/payment-methods/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const row = await app.prisma.paymentMethod.findFirst({
      where: { id, userId: user.id },
      select: SELECT,
    });
    if (row === null) throw notFound('Metodo di pagamento');

    return reply.send(toPaymentMethod(row));
  });

  app.post('/payment-methods', guarded, async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(paymentMethodInputSchema, request.body);

    try {
      const row = await app.prisma.paymentMethod.create({
        data: { ...input, userId: user.id },
        select: SELECT,
      });
      return await reply.status(201).send(toPaymentMethod(row));
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName('un metodo di pagamento', input.label);
      throw error;
    }
  });

  app.put('/payment-methods/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    const input = parseBody(paymentMethodInputSchema, request.body);

    try {
      const row = await app.prisma.paymentMethod.update({
        where: { id, userId: user.id },
        data: input,
        select: SELECT,
      });
      return await reply.send(toPaymentMethod(row));
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName('un metodo di pagamento', input.label);
      if (isRecordNotFound(error)) throw notFound('Metodo di pagamento');
      throw error;
    }
  });

  /**
   * Come per clienti e fornitori: si cancella solo ciò che non ha storico.
   *
   * I documenti non entrano nel conto perché non esiste la relazione, ma nei
   * dettagli dell'errore viaggiano lo stesso a zero: il formato di
   * `RESOURCE_IN_USE` è uno solo, e un frontend che leggesse `documents`
   * trovandolo assente stamperebbe «undefined documenti».
   */
  app.delete('/payment-methods/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const existing = await app.prisma.paymentMethod.findFirst({
      where: { id, userId: user.id },
      select: { label: true, _count: { select: { expenses: true } } },
    });
    if (existing === null) throw notFound('Metodo di pagamento');

    if (existing._count.expenses > 0) {
      throw inUse(`Il metodo di pagamento «${existing.label}»`, {
        expenses: existing._count.expenses,
        documents: 0,
      });
    }

    await app.prisma.paymentMethod.delete({ where: { id, userId: user.id } });
    return reply.status(204).send();
  });
}
