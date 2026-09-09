import {
  type ArchivedFilter,
  type Paginated,
  RESOURCE_ERROR_CODES,
  type ResourceInUseDetails,
} from '@easygest/shared';
import { z } from 'zod';

/**
 * Meccanica comune agli elenchi e al CRUD delle anagrafiche.
 *
 * Clienti e fornitori hanno campi diversi e nessuna astrazione li unifica: due
 * tabelle con le stesse colonne sarebbero il modo migliore per ritrovarsi con
 * un cliente che ha il campo «pannello di controllo». Quello che invece si
 * ripete davvero, parola per parola, sta qui.
 */

/**
 * Errore già nel formato che l'error handler di `app.ts` sa leggere.
 *
 * `statusCode`, `code` e `details` sono i tre campi che vengono letti da un
 * errore annotato: definendoli qui, una regola violata esce dall'API nel
 * formato giusto senza che ogni rotta debba tradurla.
 */
export class ResourceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ResourceError';
  }
}

/** L'identificativo nel percorso. Vale per tutte le rotte `/qualcosa/:id`. */
export const idParamSchema = z.object({ id: z.string().min(1) });

export function notFound(what: string): ResourceError {
  return new ResourceError(404, 'NOT_FOUND', `${what} inesistente`);
}

export function duplicateName(what: string, name: string): ResourceError {
  return new ResourceError(
    409,
    RESOURCE_ERROR_CODES.duplicateName,
    `Esiste già ${what} di nome «${name}»`,
  );
}

/**
 * Rifiuto di cancellare qualcosa che il seed ricrea.
 *
 * Non è una protezione dall'utente, è una constatazione: la riga tornerebbe al
 * prossimo avvio del seed, quindi la cancellazione non sarebbe una
 * cancellazione ma una sparizione temporanea, tanto più confondente perché
 * riuscirebbe. Il messaggio indica l'archiviazione, che invece resta.
 */
export function systemManaged(what: string): ResourceError {
  return new ResourceError(
    409,
    RESOURCE_ERROR_CODES.systemManaged,
    `${what} fa parte di quelle predefinite e il seed la ricreerebbe. Archiviala per toglierla dagli elenchi.`,
  );
}

/**
 * Rifiuto di cancellare qualcosa a cui è agganciato dello storico.
 *
 * I conteggi viaggiano nei dettagli perché il messaggio da solo non basta a
 * decidere cosa fare: sapere che ci sono tre spese e nessun documento dice
 * dove andare a guardare.
 */
export function inUse(what: string, counts: ResourceInUseDetails): ResourceError {
  return new ResourceError(
    409,
    RESOURCE_ERROR_CODES.inUse,
    `${what} è collegato a dello storico e non si può cancellare. Archivialo per toglierlo dagli elenchi.`,
    counts,
  );
}

/**
 * Riconosce la violazione di un vincolo di unicità.
 *
 * Il controllo passa da qui e non da una `findFirst` preventiva perché fra la
 * lettura e la scrittura ci sta un'altra richiesta: l'unica garanzia è il
 * vincolo del database, e questa funzione serve a tradurne l'errore in una
 * risposta comprensibile invece che in un 500.
 */
export function isUniqueViolation(error: unknown): boolean {
  return hasPrismaCode(error, 'P2002');
}

/**
 * La riga da modificare non esiste, o non è di chi l'ha chiesta.
 *
 * Le due cose non si distinguono di proposito: la `where` di ogni modifica
 * contiene sia l'id sia lo `userId`, quindi il record di un altro utente non
 * viene trovato esattamente come uno inesistente. Rispondere «esiste ma non è
 * tuo» direbbe a chi prova che quell'id è buono.
 */
export function isRecordNotFound(error: unknown): boolean {
  return hasPrismaCode(error, 'P2025');
}

function hasPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === code;
}

/** Traduce il filtro degli archiviati in una condizione, o in nessuna. */
export function activeFilter(archived: ArchivedFilter): { isActive?: boolean } {
  switch (archived) {
    case 'exclude':
      return { isActive: true };
    case 'only':
      return { isActive: false };
    case 'include':
      return {};
  }
}

export function pageWindow(page: number, perPage: number): { skip: number; take: number } {
  return { skip: (page - 1) * perPage, take: perPage };
}

export function paginate<T>(
  items: T[],
  total: number,
  page: number,
  perPage: number,
): Paginated<T> {
  return { items, page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) };
}
