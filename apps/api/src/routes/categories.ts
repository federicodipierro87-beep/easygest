import { type Category, categoryInputSchema, categoryListQuerySchema } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { Category as CategoryRecord, Prisma } from '../generated/prisma/client';
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
  systemManaged,
} from '../lib/resources';
import { parseBody, parseQuery } from '../lib/validation';
import { requireUser } from '../plugins/auth';

const SELECT = {
  id: true,
  name: true,
  scope: true,
  color: true,
  icon: true,
  isSystem: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { expenses: true, documents: true } },
} satisfies Prisma.CategorySelect;

type CategoryRow = Omit<CategoryRecord, 'userId'> & {
  _count: { expenses: number; documents: number };
};

function toCategory({ _count, createdAt, updatedAt, icon, ...rest }: CategoryRow): Category {
  return {
    ...rest,
    // L'elenco delle icone è chiuso e validato in ingresso, ma la colonna è
    // una stringa qualsiasi: una riga scritta prima che l'elenco esistesse, o
    // a mano in SQL, può contenere un nome che il frontend non sa disegnare.
    icon: icon as Category['icon'],
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    expenseCount: _count.expenses,
    documentCount: _count.documents,
  };
}

export function registerCategoryRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: app.authenticate };

  app.get('/categories', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { q, page, perPage, archived, sort, direction, usableFor } = parseQuery(
      categoryListQuerySchema,
      request.query,
    );

    const where = {
      userId: user.id,
      ...activeFilter(archived),
      // «Usabile per le spese» include le categorie marcate `BOTH`: chiedere
      // l'uguaglianza secca darebbe un elenco incompleto senza sembrare
      // sbagliato, ed è il modo in cui il menù a tendina della Fase 2
      // perderebbe silenziosamente metà delle voci.
      ...(usableFor === undefined ? {} : { scope: { in: [usableFor, 'BOTH' as const] } }),
      // Una categoria ha un nome e basta: qui non c'è il resto dei campi su cui
      // si cerca un cliente, perché non c'è altro da cercare.
      ...(q === undefined ? {} : { name: { contains: q, mode: 'insensitive' as const } }),
    } satisfies Prisma.CategoryWhereInput;

    const [rows, total] = await Promise.all([
      app.prisma.category.findMany({
        where,
        select: SELECT,
        orderBy: [{ [sort]: direction }, { id: 'asc' }],
        ...pageWindow(page, perPage),
      }),
      app.prisma.category.count({ where }),
    ]);

    return reply.send(paginate(rows.map(toCategory), total, page, perPage));
  });

  app.get('/categories/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const row = await app.prisma.category.findFirst({
      where: { id, userId: user.id },
      select: SELECT,
    });
    if (row === null) throw notFound('Categoria');

    return reply.send(toCategory(row));
  });

  app.post('/categories', guarded, async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(categoryInputSchema, request.body);

    /**
     * Le nuove vanno in fondo.
     *
     * `sortOrder` non è nel corpo: è il server a deciderlo, perché è l'unico
     * che sa cosa c'è già. Metterle tutte a zero le mescolerebbe alle prime
     * del seed, e in un menù a tendina «Hosting e server» smetterebbe di
     * essere la prima voce senza che nessuno l'abbia chiesto.
     *
     * Due creazioni contemporanee otterrebbero lo stesso numero. Non è un
     * problema: `sortOrder` non è unico e l'ordinamento ha `id` come secondo
     * criterio, quindi il risultato è stabile — semplicemente le due nuove
     * categorie finiscono affiancate.
     */
    const { _max } = await app.prisma.category.aggregate({
      where: { userId: user.id },
      _max: { sortOrder: true },
    });

    try {
      const row = await app.prisma.category.create({
        data: { ...input, userId: user.id, sortOrder: (_max.sortOrder ?? -1) + 1 },
        select: SELECT,
      });
      return await reply.status(201).send(toCategory(row));
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName('una categoria', input.name);
      throw error;
    }
  });

  /**
   * Sostituisce la categoria, `isSystem` e `sortOrder` esclusi.
   *
   * Non sono nel corpo e non ci finiscono: lo schema è `strictObject`, quindi
   * mandarli è un errore di validazione e non un campo ignorato. È ciò che
   * impedisce a una `PUT` costruita a mano di togliersi da sola il flag che
   * blocca la cancellazione.
   *
   * Rinominare e ricolorare una categoria di sistema invece si può, ed è
   * coerente con il seed, che dichiara di non voler disfare le modifiche
   * dell'utente su nome, colore e icona.
   */
  app.put('/categories/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    const input = parseBody(categoryInputSchema, request.body);

    try {
      const row = await app.prisma.category.update({
        where: { id, userId: user.id },
        data: input,
        select: SELECT,
      });
      return await reply.send(toCategory(row));
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName('una categoria', input.name);
      if (isRecordNotFound(error)) throw notFound('Categoria');
      throw error;
    }
  });

  /**
   * Due rifiuti possibili, per due ragioni diverse.
   *
   * Le categorie di sistema non si cancellano perché il seed le ricrea per
   * nome: l'operazione riuscirebbe e poi si disferebbe da sola al prossimo
   * avvio, che è peggio di un rifiuto. Le altre non si cancellano se hanno
   * storico, perché `onDelete: SetNull` toglierebbe l'etichetta a spese e
   * documenti già classificati. In entrambi i casi la via d'uscita è
   * l'archiviazione, che toglie la voce dai menù senza staccare niente.
   */
  app.delete('/categories/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const existing = await app.prisma.category.findFirst({
      where: { id, userId: user.id },
      select: {
        name: true,
        isSystem: true,
        _count: { select: { expenses: true, documents: true } },
      },
    });
    if (existing === null) throw notFound('Categoria');

    if (existing.isSystem) throw systemManaged(`La categoria «${existing.name}»`);

    const counts = {
      expenses: existing._count.expenses,
      documents: existing._count.documents,
    };
    if (counts.expenses > 0 || counts.documents > 0) {
      throw inUse(`La categoria «${existing.name}»`, counts);
    }

    await app.prisma.category.delete({ where: { id, userId: user.id } });
    return reply.status(204).send();
  });
}
