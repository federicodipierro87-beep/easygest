import { type Vendor, vendorInputSchema, vendorListQuerySchema } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { Prisma, Vendor as VendorRecord } from '../generated/prisma/client';
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
  name: true,
  website: true,
  supportEmail: true,
  accountRef: true,
  portalUrl: true,
  vatNumber: true,
  countryCode: true,
  notes: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { expenses: true, documents: true } },
} satisfies Prisma.VendorSelect;

type VendorRow = Omit<VendorRecord, 'userId'> & {
  _count: { expenses: number; documents: number };
};

function toVendor({ _count, createdAt, updatedAt, ...rest }: VendorRow): Vendor {
  return {
    ...rest,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    expenseCount: _count.expenses,
    documentCount: _count.documents,
  };
}

/**
 * Le rotte dei fornitori sono la copia di quelle dei clienti, e restano due
 * file.
 *
 * Unificarle dietro una funzione generica sui due modelli si può fare, ma il
 * guadagno è una trentina di righe e il costo è che i campi delle due
 * anagrafiche smettono di essere visibili dove si usano. Divergeranno: un
 * fornitore avrà la data di rinnovo del contratto, un cliente le condizioni di
 * pagamento. Meglio due file che si leggono da soli.
 */
export function registerVendorRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: app.authenticate };

  app.get('/vendors', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { q, page, perPage, archived, sort, direction } = parseQuery(
      vendorListQuerySchema,
      request.query,
    );

    const where = {
      userId: user.id,
      ...activeFilter(archived),
      // Il numero cliente è fra i campi cercabili perché è così che un
      // fornitore si ritrova partendo da una email di rinnovo, dove il nome
      // commerciale magari non compare nemmeno.
      ...(q === undefined
        ? {}
        : {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { accountRef: { contains: q, mode: 'insensitive' } },
              { vatNumber: { contains: q, mode: 'insensitive' } },
              { website: { contains: q, mode: 'insensitive' } },
            ],
          }),
    } satisfies Prisma.VendorWhereInput;

    const [rows, total] = await Promise.all([
      app.prisma.vendor.findMany({
        where,
        select: SELECT,
        orderBy: [{ [sort]: direction }, { id: 'asc' }],
        ...pageWindow(page, perPage),
      }),
      app.prisma.vendor.count({ where }),
    ]);

    return reply.send(paginate(rows.map(toVendor), total, page, perPage));
  });

  app.get('/vendors/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const row = await app.prisma.vendor.findFirst({
      where: { id, userId: user.id },
      select: SELECT,
    });
    if (row === null) throw notFound('Fornitore');

    return reply.send(toVendor(row));
  });

  app.post('/vendors', guarded, async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(vendorInputSchema, request.body);

    try {
      const row = await app.prisma.vendor.create({
        data: { ...input, userId: user.id },
        select: SELECT,
      });
      return await reply.status(201).send(toVendor(row));
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName('un fornitore', input.name);
      throw error;
    }
  });

  app.put('/vendors/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    const input = parseBody(vendorInputSchema, request.body);

    try {
      const row = await app.prisma.vendor.update({
        where: { id, userId: user.id },
        data: input,
        select: SELECT,
      });
      return await reply.send(toVendor(row));
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName('un fornitore', input.name);
      if (isRecordNotFound(error)) throw notFound('Fornitore');
      throw error;
    }
  });

  app.delete('/vendors/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const existing = await app.prisma.vendor.findFirst({
      where: { id, userId: user.id },
      select: { name: true, _count: { select: { expenses: true, documents: true } } },
    });
    if (existing === null) throw notFound('Fornitore');

    const counts = {
      expenses: existing._count.expenses,
      documents: existing._count.documents,
    };
    if (counts.expenses > 0 || counts.documents > 0) {
      throw inUse(`Il fornitore «${existing.name}»`, counts);
    }

    await app.prisma.vendor.delete({ where: { id, userId: user.id } });
    return reply.status(204).send();
  });
}
