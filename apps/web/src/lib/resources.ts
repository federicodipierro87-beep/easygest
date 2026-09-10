import type { ArchivedFilter, Paginated, ResourceInUseDetails } from '@easygest/shared';
import { RESOURCE_ERROR_CODES } from '@easygest/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { ApiError } from './api';
import { authFetch } from './session';

/**
 * Accesso alle anagrafiche dal frontend.
 *
 * Qui, a differenza delle rotte, l'astrazione ha senso. Sul server clienti e
 * fornitori restano due file perché i loro campi divergeranno; da questa parte
 * invece non compare nemmeno un campo: cambia solo la stringa del percorso, e
 * il resto — costruire la query string, invalidare la cache, riconoscere un
 * 409 — è identico e continuerà a esserlo.
 */

export interface ListParams {
  q: string;
  page: number;
  archived: ArchivedFilter;
  sort: string;
  direction: 'asc' | 'desc';
}

/**
 * Le coppie che l'utente ha davvero scelto, in una query string.
 *
 * `undefined` vuol dire «su questo non chiedo niente», e la chiave sparisce. I
 * default li ha già lo schema Zod dell'API: ripeterli qui vorrebbe dire
 * mantenerli allineati in due posti, e soprattutto farebbe di ogni ricerca
 * vuota una chiave di cache diversa da quella dell'elenco iniziale.
 *
 * È l'unica parte di questo modulo che le spese riusano: tutto il resto qui
 * parla di anagrafiche, questa non parla di niente.
 */
export function queryString(entries: readonly (readonly [string, string | undefined])[]): string {
  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined) search.set(key, value);
  }
  return search.toString();
}

function toSearchParams(params: ListParams): string {
  return queryString([
    ['q', params.q === '' ? undefined : params.q],
    ['page', params.page === 1 ? undefined : String(params.page)],
    ['archived', params.archived === 'exclude' ? undefined : params.archived],
    ['sort', params.sort],
    ['direction', params.direction],
  ]);
}

/**
 * Le chiavi di cache di una risorsa.
 *
 * `['clients']` come radice permette di invalidare ogni elenco in un colpo
 * dopo una scrittura, senza sapere con quali filtri l'utente stia guardando.
 */
export function resourceKeys(resource: string) {
  return {
    all: [resource] as const,
    list: (params: ListParams) => [resource, 'list', params] as const,
  };
}

export function listQueryOptions<T>(resource: string, params: ListParams) {
  return queryOptions({
    queryKey: resourceKeys(resource).list(params),
    queryFn: () => authFetch<Paginated<T>>(`/${resource}?${toSearchParams(params)}`),
    /**
     * Cambiando pagina o filtro i dati precedenti restano a schermo finché non
     * arrivano i nuovi. Senza, la tabella sparisce e ricompare a ogni lettera
     * digitata nella ricerca, e la pagina salta.
     */
    placeholderData: (previous: Paginated<T> | undefined) => previous,
  });
}

/**
 * Le tre scritture di una risorsa, con l'invalidazione già collegata.
 *
 * Ogni mutazione invalida l'intera radice: dopo aver creato un cliente non si
 * sa in quale pagina dell'elenco finirà né se il filtro attivo lo includa,
 * quindi l'unica risposta corretta è «rileggi quello che stai guardando».
 */
export function useResourceMutations<T, Input>(resource: string) {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: resourceKeys(resource).all });
  };

  const create = useMutation({
    mutationFn: (input: Input) =>
      authFetch<T>(`/${resource}`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Input }) =>
      authFetch<T>(`/${resource}/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => authFetch<void>(`/${resource}/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

/**
 * Traduce gli errori di validazione dell'API in errori per campo.
 *
 * Il server è l'unico che valida davvero, quindi è l'unico che sa quale campo
 * ha rifiutato e perché. Mostrare quel messaggio in fondo al modulo come
 * «Dati non validi» costringerebbe a cercare a occhio quale delle dodici
 * caselle è sbagliata.
 */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return {};

  const result: Record<string, string> = {};
  for (const detail of error.details as unknown[]) {
    if (typeof detail !== 'object' || detail === null) continue;
    const { field, message } = detail as { field?: unknown; message?: unknown };
    // Il primo messaggio per campo: Zod può produrne più d'uno sulla stessa
    // casella, e sotto una casella ci sta una riga.
    if (typeof field === 'string' && typeof message === 'string' && !(field in result)) {
      result[field] = message;
    }
  }
  return result;
}

/**
 * I conteggi che accompagnano un rifiuto di cancellazione.
 *
 * Restituisce `null` quando l'errore è un altro, così chi chiama distingue
 * «non si può cancellare, ecco perché» da un guasto qualunque.
 */
export function inUseDetails(error: unknown): ResourceInUseDetails | null {
  if (!(error instanceof ApiError) || error.code !== RESOURCE_ERROR_CODES.inUse) return null;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return null;
  const { expenses, documents } = details as { expenses?: unknown; documents?: unknown };
  if (typeof expenses !== 'number' || typeof documents !== 'number') return null;
  return { expenses, documents };
}
