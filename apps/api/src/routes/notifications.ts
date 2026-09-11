import { type Notification, type UnreadCount, notificationListQuerySchema } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { Prisma } from '../generated/prisma/client';
import { idParamSchema, notFound, pageWindow, paginate } from '../lib/resources';
import { parseBody, parseQuery } from '../lib/validation';
import { requireUser } from '../plugins/auth';

/**
 * Le notifiche in-app.
 *
 * Non si creano da qui: le scrive il giro notturno, ed è l'unica cosa che le
 * scrive. Quello che si fa da qui è leggerle e segnarle lette, che sono le due
 * sole operazioni che la campanella deve saper fare.
 *
 * Non si cancellano nemmeno, e la ragione è che nessuno le vuole cancellare:
 * quelle lette le pota il cron dopo centottanta giorni, e quelle non lette sono
 * esattamente ciò che si è aperta la campanella per vedere. Un pulsante
 * «elimina» servirebbe solo a far sparire un avviso senza averlo guardato.
 */

const SELECT = {
  id: true,
  kind: true,
  title: true,
  body: true,
  entityType: true,
  entityId: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof SELECT }>;

/**
 * `entityType` esce come stringa libera dal database.
 *
 * La colonna non è un enum — punta a tabelle diverse — quindi il valore va
 * ristretto qui, dove si costruisce il DTO. Un tipo che non riconosciamo
 * diventa `null`: il frontend manderà alla pagina delle scadenze invece che a
 * un link rotto, che è il peggiore dei due esiti possibili.
 */
function toNotification(row: NotificationRow): Notification {
  const entityType =
    row.entityType === 'occurrence' ||
    row.entityType === 'expense' ||
    row.entityType === 'paymentMethod'
      ? row.entityType
      : null;

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    entityType,
    entityId: row.entityId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function registerNotificationRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: app.authenticate };

  app.get('/notifications', guarded, async (request, reply) => {
    const user = requireUser(request);
    const query = parseQuery(notificationListQuerySchema, request.query);

    const where = {
      userId: user.id,
      ...(query.unread === undefined ? {} : { readAt: query.unread ? null : { not: null } }),
    } satisfies Prisma.NotificationWhereInput;

    const [rows, total] = await Promise.all([
      app.prisma.notification.findMany({
        where,
        select: SELECT,
        // Un solo ordinamento possibile, e `id` a pareggiare: due notifiche
        // dello stesso giro hanno lo stesso `createdAt` al millisecondo, e
        // senza il secondo criterio la pagina 2 potrebbe ripetere una riga
        // della pagina 1.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageWindow(query.page, query.perPage),
      }),
      app.prisma.notification.count({ where }),
    ]);

    return reply.send(paginate(rows.map(toNotification), total, query.page, query.perPage));
  });

  /**
   * Il badge.
   *
   * Rotta a sé perché è quella che il frontend interroga ogni minuto: è un
   * `count` sull'indice `[userId, readAt, createdAt]` che esiste già, mentre
   * infilarla nell'elenco vorrebbe dire caricare venticinque righe per
   * mostrarne il numero — e romperebbe la forma di `Paginated<T>`, che è
   * uguale per tutte le risorse.
   */
  app.get('/notifications/unread-count', guarded, async (request, reply) => {
    const user = requireUser(request);
    const count = await app.prisma.notification.count({
      where: { userId: user.id, readAt: null },
    });
    const body: UnreadCount = { count };
    return reply.send(body);
  });

  /**
   * Segna letta una notifica.
   *
   * `POST` e non `PATCH`: è un'azione idempotente senza corpo, e il parser del
   * corpo vuoto esiste già, scritto per `/auth/refresh`. Un `PATCH { read:
   * true }` aprirebbe subito la domanda «e `read: false`?», che non serve a
   * nessuno: rimettere non letto un avviso già visto non è un bisogno, è una
   * simmetria.
   *
   * `readAt` non si sovrascrive se c'è già. La seconda chiamata è la stessa
   * riga già letta — di solito perché il popover si è riaperto — e spostarne
   * l'istante cancellerebbe l'unica informazione che il campo porta.
   */
  app.post('/notifications/:id/read', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const current = await app.prisma.notification.findFirst({
      where: { id, userId: user.id },
      select: { readAt: true },
    });
    // 404 e non 403 su una notifica altrui: rispondere «esiste ma non è tua»
    // direbbe a un estraneo che quell'identificatore è valido.
    if (current === null) throw notFound('Notifica');

    const row =
      current.readAt !== null
        ? await app.prisma.notification.findFirstOrThrow({ where: { id }, select: SELECT })
        : await app.prisma.notification.update({
            where: { id },
            data: { readAt: new Date() },
            select: SELECT,
          });

    return reply.send(toNotification(row));
  });

  /** Svuota il badge. Restituisce quante ne ha toccate, non l'elenco. */
  app.post('/notifications/read-all', guarded, async (request, reply) => {
    const user = requireUser(request);
    const result = await app.prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return reply.send({ updated: result.count });
  });
}
