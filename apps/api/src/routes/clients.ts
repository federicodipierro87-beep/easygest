import { type Client, clientInputSchema, clientListQuerySchema } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { Client as ClientRecord, Prisma } from '../generated/prisma/client';
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

/**
 * Colonne restituite dall'API.
 *
 * `userId` non c'è: è sempre quello di chi sta chiamando, quindi rimandarlo
 * indietro non aggiunge niente e lo espone in ogni risposta senza motivo.
 *
 * I due contatori costano una sottoquery per riga, e servono: senza,
 * l'interfaccia non può sapere che la cancellazione verrà rifiutata finché non
 * la prova.
 */
const SELECT = {
  id: true,
  name: true,
  vatNumber: true,
  taxCode: true,
  sdiCode: true,
  pecEmail: true,
  email: true,
  phone: true,
  addressLine: true,
  postalCode: true,
  city: true,
  province: true,
  countryCode: true,
  notes: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { expenses: true, documents: true } },
  // `satisfies` invece di `as const`: entrambi trattengono i letterali, ma
  // `as const` rende l'oggetto `readonly` e Prisma non lo riconosce più come
  // una selezione valida — ripiega sulla selezione di default e i tipi
  // smettono di combaciare per una ragione che non si legge dall'errore.
} satisfies Prisma.ClientSelect;

/**
 * La riga come torna da Prisma.
 *
 * Derivata dal modello invece che riscritta: se un giorno lo schema guadagna
 * una colonna, questo tipo la pretende e la `SELECT` qui sopra smette di
 * compilare finché non si decide cosa farne. Una copia scritta a mano invece
 * resterebbe indietro in silenzio.
 */
type ClientRow = Omit<ClientRecord, 'userId'> & {
  _count: { expenses: number; documents: number };
};

function toClient({ _count, createdAt, updatedAt, ...rest }: ClientRow): Client {
  return {
    ...rest,
    // JSON non ha un tipo data: la scelta è fra una stringa ISO e un numero,
    // e la stringa si legge anche a occhio nudo dentro una risposta.
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    expenseCount: _count.expenses,
    documentCount: _count.documents,
  };
}

export function registerClientRoutes(app: FastifyInstance): void {
  /**
   * Ogni rotta è protetta e ogni query filtra per `userId`.
   *
   * Non è una precauzione teorica per il giorno in cui gli utenti saranno più
   * d'uno: è la differenza fra un identificativo indovinato che non trova
   * niente e uno che restituisce i dati di qualcun altro.
   */
  const guarded = { preHandler: app.authenticate };

  app.get('/clients', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { q, page, perPage, archived, sort, direction } = parseQuery(
      clientListQuerySchema,
      request.query,
    );

    const where = {
      userId: user.id,
      ...activeFilter(archived),
      // La ricerca guarda anche i codici e la città, non solo il nome: un
      // cliente lo si cerca col nome, ma una fattura in mano riporta la
      // partita IVA e nient'altro di riconoscibile.
      ...(q === undefined
        ? {}
        : {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { vatNumber: { contains: q, mode: 'insensitive' } },
              { taxCode: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { city: { contains: q, mode: 'insensitive' } },
            ],
          }),
    } satisfies Prisma.ClientWhereInput;

    const [rows, total] = await Promise.all([
      app.prisma.client.findMany({
        where,
        select: SELECT,
        // L'id come secondo criterio non è decorativo: ordinando per data due
        // record creati nello stesso istante avrebbero ordine arbitrario, e
        // fra una pagina e l'altra uno comparirebbe due volte mentre un altro
        // sparirebbe.
        orderBy: [{ [sort]: direction }, { id: 'asc' }],
        ...pageWindow(page, perPage),
      }),
      app.prisma.client.count({ where }),
    ]);

    return reply.send(paginate(rows.map(toClient), total, page, perPage));
  });

  app.get('/clients/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const row = await app.prisma.client.findFirst({
      where: { id, userId: user.id },
      select: SELECT,
    });
    if (row === null) throw notFound('Cliente');

    return reply.send(toClient(row));
  });

  app.post('/clients', guarded, async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(clientInputSchema, request.body);

    try {
      const row = await app.prisma.client.create({
        data: { ...input, userId: user.id },
        select: SELECT,
      });
      return await reply.status(201).send(toClient(row));
    } catch (error) {
      // Il nome è unico per utente. Il controllo non si fa con una lettura
      // preventiva perché fra quella e la scrittura ci sta un'altra
      // richiesta: l'unica garanzia è il vincolo, e qui se ne traduce
      // l'errore.
      if (isUniqueViolation(error)) throw duplicateName('un cliente', input.name);
      throw error;
    }
  });

  /**
   * Sostituisce il cliente per intero, campi vuoti compresi.
   *
   * `isActive` fa parte del corpo, quindi archiviare e ripescare passano di
   * qui invece di avere due rotte dedicate: sono la stessa scrittura, e
   * l'interfaccia ha già il record sotto mano.
   */
  app.put('/clients/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);
    const input = parseBody(clientInputSchema, request.body);

    try {
      const row = await app.prisma.client.update({
        where: { id, userId: user.id },
        data: input,
        select: SELECT,
      });
      return await reply.send(toClient(row));
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName('un cliente', input.name);
      if (isRecordNotFound(error)) throw notFound('Cliente');
      throw error;
    }
  });

  /**
   * Cancella davvero, ma solo se non c'è niente attaccato.
   *
   * Le spese e i documenti puntano al cliente con `onDelete: SetNull`: una
   * cancellazione non romperebbe nulla, staccherebbe però l'attribuzione, e
   * una fattura di tre anni fa senza più il nome di chi l'ha pagata è una
   * perdita silenziosa. Chi ha storico si archivia; chi è stato inserito per
   * sbaglio si toglie, e il nome torna disponibile.
   */
  app.delete('/clients/:id', guarded, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseBody(idParamSchema, request.params);

    const existing = await app.prisma.client.findFirst({
      where: { id, userId: user.id },
      select: { name: true, _count: { select: { expenses: true, documents: true } } },
    });
    if (existing === null) throw notFound('Cliente');

    const counts = {
      expenses: existing._count.expenses,
      documents: existing._count.documents,
    };
    if (counts.expenses > 0 || counts.documents > 0) {
      throw inUse(`Il cliente «${existing.name}»`, counts);
    }

    await app.prisma.client.delete({ where: { id, userId: user.id } });
    return reply.status(204).send();
  });
}
