import { randomUUID } from 'node:crypto';

import {
  DOCUMENT_ERROR_CODES,
  type Document,
  type DocumentInput,
  type DocumentListQuery,
  type DocumentUploadTicket,
  documentCreateSchema,
  documentInputSchema,
  documentListQuerySchema,
  documentUploadRequestSchema,
  formatIsoDate,
} from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Env } from '../config/env';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import {
  ResourceError,
  idParamSchema,
  isRecordNotFound,
  isUniqueViolation,
  notFound,
  paginate,
} from '../lib/resources';
import { parseBody, parseQuery } from '../lib/validation';
import { requireUser } from '../plugins/auth';

/**
 * L'archivio dei documenti.
 *
 * Il file e la riga nascono in due tempi — vedi `documents.ts` in `shared` —
 * e muoiono nell'ordine inverso: prima la riga, poi il file. Al contrario, un
 * errore a metà lascerebbe un documento che punta a un file che non c'è più;
 * così lascia al massimo un file che nessuno nomina, che occupa spazio ma non
 * rompe niente.
 */

const SELECT = {
  id: true,
  kind: true,
  title: true,
  number: true,
  issueDate: true,
  dueDate: true,
  periodStart: true,
  periodEnd: true,
  paidAt: true,
  clientId: true,
  vendorId: true,
  categoryId: true,
  netCents: true,
  vatRateBp: true,
  vatCents: true,
  grossCents: true,
  currency: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  checksumSha256: true,
  tags: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { name: true } },
  vendor: { select: { name: true } },
  category: { select: { name: true } },
  _count: { select: { occurrences: true } },
} satisfies Prisma.DocumentSelect;

type DocumentRow = Prisma.DocumentGetPayload<{ select: typeof SELECT }>;

const isoOrNull = (date: Date | null) => (date === null ? null : formatIsoDate(date));

function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    number: row.number,
    issueDate: formatIsoDate(row.issueDate),
    dueDate: isoOrNull(row.dueDate),
    periodStart: isoOrNull(row.periodStart),
    periodEnd: isoOrNull(row.periodEnd),
    // È un istante, non un giorno: esce per intero.
    paidAt: row.paidAt?.toISOString() ?? null,
    clientId: row.clientId,
    vendorId: row.vendorId,
    categoryId: row.categoryId,
    clientName: row.client?.name ?? null,
    vendorName: row.vendor?.name ?? null,
    categoryName: row.category?.name ?? null,
    netCents: row.netCents,
    vatRateBp: row.vatRateBp,
    vatCents: row.vatCents,
    grossCents: row.grossCents,
    currency: row.currency,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    tags: row.tags,
    notes: row.notes,
    occurrenceCount: row._count.occurrences,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * La chiave sullo storage: l'utente nel prefisso, poi un identificativo a caso.
 *
 * Il nome del file non c'è di proposito. Viaggia nei metadati e torna nel
 * `Content-Disposition` al download; nella chiave porterebbe accenti, spazi e
 * barre da codificare, e renderebbe due caricamenti dello stesso nome una
 * collisione. Il prefisso invece serve: è ciò che permette di verificare che
 * la chiave restituita alla registrazione sia davvero di chi la usa.
 */
const keyPrefix = (userId: string) => `documents/${userId}/`;

async function assertRelationsOwned(
  prisma: PrismaClient,
  userId: string,
  input: Pick<DocumentInput, 'clientId' | 'vendorId' | 'categoryId'>,
): Promise<void> {
  const exists = async (id: string | null, query: (id: string) => Promise<number>) =>
    id === null || (await query(id)) > 0;
  const checks = await Promise.all([
    exists(input.clientId, (id) => prisma.client.count({ where: { id, userId } })),
    exists(input.vendorId, (id) => prisma.vendor.count({ where: { id, userId } })),
    exists(input.categoryId, (id) => prisma.category.count({ where: { id, userId } })),
  ]);
  const fields = ['clientId', 'vendorId', 'categoryId'] as const;
  const unknown = fields.filter((_, index) => !checks[index]);
  if (unknown.length === 0) return;
  throw new ResourceError(
    422,
    DOCUMENT_ERROR_CODES.unknownRelation,
    'Alcuni collegamenti indicati non esistono',
    { fields: unknown },
  );
}

/**
 * Gli id che rispondono a una ricerca, dal più pertinente.
 *
 * Due ricerche in una. Il full-text trova le parole intere anche flesse —
 * «fatture» trova «fattura» — ma non i pezzi: «arub» in un `tsvector` non c'è.
 * I trigram coprono quel caso e i refusi, e sono il motivo dei due indici
 * `gin_trgm_ops` su titolo e numero; `ILIKE` con i `%` intorno li usa.
 *
 * Restituisce solo gli id, non le righe: i filtri e le relazioni restano a
 * Prisma, che li sa scrivere, e la pertinenza — che Prisma non sa esprimere —
 * resta qui. Il prezzo è che la paginazione di una ricerca si fa in memoria;
 * il `LIMIT` lo rende un prezzo fisso, e mille risultati per una parola in un
 * archivio personale vorrebbero dire che la parola non serve a cercare.
 */
const SEARCH_LIMIT = 1000;

async function searchIds(
  prisma: PrismaClient,
  userId: string,
  q: string,
): Promise<Map<string, number>> {
  // I caratteri jolly di LIKE vanno neutralizzati: «100%» è un testo da
  // cercare, non «100 seguito da qualunque cosa».
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await prisma.$queryRaw<{ id: string; rank: number }[]>`
    SELECT "id",
           ts_rank("searchVector", websearch_to_tsquery('italian', ${q}))
             + greatest(similarity("title", ${q}), similarity(coalesce("number", ''), ${q}))
             AS "rank"
      FROM "Document"
     WHERE "userId" = ${userId}
       AND (    "searchVector" @@ websearch_to_tsquery('italian', ${q})
             OR "title" ILIKE ${like}
             OR "number" ILIKE ${like}
             OR "title" % ${q}
             OR ${q.toLowerCase()} = ANY("tags"))
     ORDER BY "rank" DESC, "issueDate" DESC
     LIMIT ${SEARCH_LIMIT}`;
  return new Map(rows.map((row) => [row.id, Number(row.rank)]));
}

const NULLABLE_SORT_FIELDS = new Set<DocumentListQuery['sort']>(['dueDate', 'grossCents']);

const downloadQuerySchema = z.object({
  disposition: z.enum(['inline', 'attachment']).default('inline'),
});

export function registerDocumentRoutes(app: FastifyInstance, env: Env): void {
  const guarded = { preHandler: app.authenticate };

  app.get('/documents', guarded, async (request, reply) => {
    const user = requireUser(request);
    const query = parseQuery(documentListQuerySchema, request.query);

    const ranks = query.q === undefined ? null : await searchIds(app.prisma, user.id, query.q);

    const where = {
      userId: user.id,
      ...(ranks === null ? {} : { id: { in: [...ranks.keys()] } }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.clientId === undefined ? {} : { clientId: query.clientId }),
      ...(query.vendorId === undefined ? {} : { vendorId: query.vendorId }),
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      ...(query.tag === undefined ? {} : { tags: { has: query.tag } }),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            issueDate: {
              ...(query.from === undefined ? {} : { gte: query.from }),
              ...(query.to === undefined ? {} : { lte: query.to }),
            },
          }),
    } satisfies Prisma.DocumentWhereInput;

    if (ranks !== null) {
      const rows = await app.prisma.document.findMany({ where, select: SELECT });
      rows.sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0));
      const start = (query.page - 1) * query.perPage;
      return reply.send(
        paginate(
          rows.slice(start, start + query.perPage).map(toDocument),
          rows.length,
          query.page,
          query.perPage,
        ),
      );
    }

    const [rows, total] = await Promise.all([
      app.prisma.document.findMany({
        where,
        select: SELECT,
        // I nulli in fondo in entrambe le direzioni: un documento senza
        // scadenza non è né il più urgente né il meno. Solo sulle colonne che
        // ne hanno: su una obbligatoria Prisma rifiuta `nulls`, con un 500.
        orderBy: [
          NULLABLE_SORT_FIELDS.has(query.sort)
            ? { [query.sort]: { sort: query.direction, nulls: 'last' } }
            : { [query.sort]: query.direction },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      app.prisma.document.count({ where }),
    ]);
    return reply.send(paginate(rows.map(toDocument), total, query.page, query.perPage));
  });

  app.get('/documents/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    const row = await app.prisma.document.findFirst({
      where: { id, userId: user.id },
      select: SELECT,
    });
    if (row === null) throw notFound('Documento');
    return reply.send(toDocument(row));
  });

  /**
   * Il biglietto per caricare: una chiave nuova e un URL firmato su di lei.
   *
   * Non scrive niente nel database. Un caricamento abbandonato a metà lascia
   * al più un file senza riga, non una riga senza file.
   */
  app.post('/documents/uploads', guarded, async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(documentUploadRequestSchema, request.body);
    if (input.sizeBytes > env.DOCUMENT_MAX_BYTES) {
      throw new ResourceError(
        422,
        DOCUMENT_ERROR_CODES.fileTooLarge,
        `Il file supera il limite di ${String(Math.floor(env.DOCUMENT_MAX_BYTES / 1024 / 1024))} MB`,
      );
    }

    const storageKey = `${keyPrefix(user.id)}${randomUUID()}`;
    const [upload, duplicates] = await Promise.all([
      app.storage.presignUpload({
        key: storageKey,
        contentType: input.mimeType,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
      }),
      app.prisma.document.findMany({
        where: { userId: user.id, checksumSha256: input.checksumSha256 },
        select: { id: true, title: true, kind: true, issueDate: true },
        orderBy: { issueDate: 'desc' },
        take: 5,
      }),
    ]);

    const ticket: DocumentUploadTicket = {
      storageKey,
      upload: { ...upload, expiresAt: upload.expiresAt.toISOString() },
      duplicates: duplicates.map((d) => ({ ...d, issueDate: formatIsoDate(d.issueDate) })),
    };
    return reply.status(201).send(ticket);
  });

  /**
   * Registra un documento il cui file è già sullo storage.
   *
   * Il contenuto non si ricontrolla: impronta e dimensione erano firmate
   * dentro l'URL, e lo storage ha già rifiutato un file diverso. Si controlla
   * invece che il file ci sia — un caricamento fallito o mai partito — e che
   * la dimensione sia quella annunciata, perché è l'unica cosa che una HEAD
   * può dire e costa un viaggio solo.
   */
  app.post('/documents', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { document: input, file } = parseBody(documentCreateSchema, request.body);

    // Una chiave fuori dal proprio prefisso è una chiave di un altro, o una
    // inventata: si risponde come se il file non ci fosse, che è vero per chi
    // chiede.
    const stored = file.storageKey.startsWith(keyPrefix(user.id))
      ? await app.storage.head(file.storageKey)
      : null;
    if (stored === null) {
      throw new ResourceError(
        422,
        DOCUMENT_ERROR_CODES.uploadMissing,
        'Il file non risulta caricato: riprova il caricamento',
      );
    }
    if (stored.sizeBytes !== file.sizeBytes) {
      throw new ResourceError(
        422,
        DOCUMENT_ERROR_CODES.uploadMismatch,
        'Il file caricato non corrisponde a quello annunciato',
      );
    }
    await assertRelationsOwned(app.prisma, user.id, input);

    try {
      const row = await app.prisma.document.create({
        data: {
          ...toData(input),
          userId: user.id,
          storageKey: file.storageKey,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          checksumSha256: file.checksumSha256,
        },
        select: SELECT,
      });
      return await reply.status(201).send(toDocument(row));
    } catch (error) {
      // Lo stesso biglietto usato due volte: un doppio clic, o un ritentativo
      // dopo una risposta persa. Il documento c'è già.
      if (isUniqueViolation(error)) {
        throw new ResourceError(409, 'DUPLICATE_UPLOAD', 'Questo caricamento è già registrato');
      }
      throw error;
    }
  });

  app.put('/documents/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    const input = parseBody(documentInputSchema, request.body);
    await assertRelationsOwned(app.prisma, user.id, input);

    try {
      const row = await app.prisma.document.update({
        where: { id, userId: user.id },
        data: toData(input),
        select: SELECT,
      });
      return await reply.send(toDocument(row));
    } catch (error) {
      if (isRecordNotFound(error)) throw notFound('Documento');
      throw error;
    }
  });

  /**
   * Un URL firmato per aprire il file, non il file.
   *
   * Il browser lo segue da sé: il file viaggia dal bucket al browser senza
   * passare di qui, come all'andata. Scade in cinque minuti, quindi non si
   * salva in un segnalibro — si richiede ogni volta.
   */
  app.get('/documents/:id/download', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    const { disposition } = parseQuery(downloadQuerySchema, request.query);
    const row = await app.prisma.document.findFirst({
      where: { id, userId: user.id },
      select: { storageKey: true, fileName: true, mimeType: true },
    });
    if (row === null) throw notFound('Documento');

    const url = await app.storage.presignDownload(row.storageKey, {
      fileName: row.fileName,
      contentType: row.mimeType,
      disposition,
    });
    return reply.send({ url });
  });

  /**
   * Cancella il documento, poi il file.
   *
   * Le scadenze a cui era allegato perdono l'allegato e restano —
   * `onDelete: SetNull` — perché il pagamento è avvenuto comunque. Se la
   * cancellazione del file fallisce, la risposta è lo stesso un successo: per
   * chi ha chiesto il documento non c'è più, e il file rimasto è solo spazio.
   */
  app.delete('/documents/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    let deleted;
    try {
      deleted = await app.prisma.document.delete({
        where: { id, userId: user.id },
        select: { storageKey: true },
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw notFound('Documento');
      throw error;
    }

    try {
      await app.storage.delete(deleted.storageKey);
    } catch (error) {
      request.log.error(
        { err: error, storageKey: deleted.storageKey },
        'File del documento non cancellato dallo storage',
      );
    }
    return reply.status(204).send();
  });
}

/** Campo per campo, per la stessa ragione di `toData` in `expenses.ts`. */
function toData(
  input: DocumentInput,
): Omit<
  Prisma.DocumentUncheckedCreateInput,
  'userId' | 'storageKey' | 'fileName' | 'mimeType' | 'sizeBytes'
> {
  return {
    kind: input.kind,
    title: input.title,
    number: input.number,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    paidAt: input.paidAt,
    clientId: input.clientId,
    vendorId: input.vendorId,
    categoryId: input.categoryId,
    netCents: input.netCents,
    vatRateBp: input.vatRateBp,
    vatCents: input.vatCents,
    grossCents: input.grossCents,
    currency: input.currency,
    tags: input.tags,
    notes: input.notes,
  };
}
