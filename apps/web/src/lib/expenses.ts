import {
  RESOURCE_ERROR_CODES,
  type Expense,
  type ExpenseFormInput,
  type ExpenseInUseDetails,
  type ExpenseOccurrence,
  type ExpenseStatus,
  type OccurrencePatch,
  type OccurrenceStatus,
  type Paginated,
} from '@easygest/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { ApiError } from './api';
import { queryString } from './resources';
import { authFetch } from './session';

/**
 * Accesso alle spese e alle loro scadenze.
 *
 * Un modulo suo e non `lib/resources.ts` allargato, per due ragioni tecniche
 * prima che estetiche.
 *
 * **Le invalidazioni sono incrociate.** Scrivere una spesa fa girare
 * `syncOccurrences` sul server, che riscrive le scadenze future; e una `PATCH`
 * su un'occorrenza cambia `nextDueDate` e `occurrenceCount` della spesa. Ogni
 * mutazione deve quindi invalidare **due** radici. `useResourceMutations` ne
 * invalida una per costruzione, ed è giusto così: un cliente salvato non tocca
 * nient'altro.
 *
 * **Manca un verbo.** Le occorrenze non si creano e non si cancellano, si
 * correggono: hanno solo `PATCH`. Aggiungerlo a `useResourceMutations` darebbe
 * alle quattro anagrafiche un metodo che il loro server non espone.
 *
 * Di davvero condiviso resta `queryString`, che infatti non nomina nessun
 * campo.
 */

/**
 * La sentinella dei filtri è `'all'`, non la stringa vuota.
 *
 * Radix riserva `value=""` per «nessuna scelta» e rifiuta con un errore a
 * runtime un `SelectItem` che la usi: la voce «Tutti» di una tendina ha bisogno
 * di un valore proprio, e tanto vale che sia leggibile anche nella chiave di
 * cache.
 */
export const ALL = 'all';

export interface ExpenseFilters {
  q: string;
  page: number;
  status: ExpenseStatus | typeof ALL;
  vendorId: string;
  categoryId: string;
  clientId: string;
  /** Solo le spese con una scadenza in questa finestra. Vuoto vale «non filtrare». */
  dueFrom: string;
  dueTo: string;
  sort: 'name' | 'startDate' | 'grossCents' | 'createdAt';
  direction: 'asc' | 'desc';
}

export const DEFAULT_EXPENSE_FILTERS: ExpenseFilters = {
  q: '',
  page: 1,
  status: ALL,
  vendorId: ALL,
  categoryId: ALL,
  clientId: ALL,
  dueFrom: '',
  dueTo: '',
  sort: 'name',
  direction: 'asc',
};

export interface OccurrenceFilters {
  q: string;
  page: number;
  expenseId: string;
  status: OccurrenceStatus | typeof ALL;
  from: string;
  to: string;
  /** Solo quelle che il cron ha dato per pagate senza che nessuno abbia guardato. */
  unconfirmed: boolean;
  sort: 'dueDate' | 'grossCents';
  direction: 'asc' | 'desc';
}

/** Quello che sceglie una tendina, oppure niente se non ha scelto. */
function chosen(value: string): string | undefined {
  return value === ALL || value === '' ? undefined : value;
}

export function expenseQueryString(filters: ExpenseFilters): string {
  return queryString([
    ['q', chosen(filters.q)],
    ['page', filters.page === 1 ? undefined : String(filters.page)],
    ['status', chosen(filters.status)],
    ['vendorId', chosen(filters.vendorId)],
    ['categoryId', chosen(filters.categoryId)],
    ['clientId', chosen(filters.clientId)],
    ['dueFrom', chosen(filters.dueFrom)],
    ['dueTo', chosen(filters.dueTo)],
    ['sort', filters.sort === 'name' ? undefined : filters.sort],
    ['direction', filters.direction === 'asc' ? undefined : filters.direction],
  ]);
}

export function occurrenceQueryString(filters: OccurrenceFilters): string {
  return queryString([
    ['q', chosen(filters.q)],
    ['page', filters.page === 1 ? undefined : String(filters.page)],
    ['expenseId', chosen(filters.expenseId)],
    ['status', chosen(filters.status)],
    ['from', chosen(filters.from)],
    ['to', chosen(filters.to)],
    // Solo `true` viaggia: lo schema legge la stringa e confronta con `'true'`,
    // quindi `unconfirmed=false` sarebbe una chiave in più che dice quanto
    // dice la sua assenza.
    ['unconfirmed', filters.unconfirmed ? 'true' : undefined],
    ['sort', filters.sort === 'dueDate' ? undefined : filters.sort],
    ['direction', filters.direction === 'asc' ? undefined : filters.direction],
  ]);
}

export const expenseKeys = {
  all: ['expenses'] as const,
  list: (filters: ExpenseFilters) => ['expenses', 'list', filters] as const,
  detail: (id: string) => ['expenses', 'detail', id] as const,
};

export const occurrenceKeys = {
  all: ['occurrences'] as const,
  list: (filters: OccurrenceFilters) => ['occurrences', 'list', filters] as const,
};

export function expenseListQueryOptions(filters: ExpenseFilters) {
  return queryOptions({
    queryKey: expenseKeys.list(filters),
    queryFn: () => authFetch<Paginated<Expense>>(`/expenses?${expenseQueryString(filters)}`),
    placeholderData: (previous: Paginated<Expense> | undefined) => previous,
  });
}

export function expenseQueryOptions(id: string) {
  return queryOptions({
    queryKey: expenseKeys.detail(id),
    queryFn: () => authFetch<Expense>(`/expenses/${id}`),
    // Un identificativo inesistente resterà inesistente al terzo tentativo: i
    // tre giri di default servono solo a far aspettare tre volte tanto prima
    // di mostrare la stessa frase.
    retry: false,
  });
}

export function occurrenceListQueryOptions(filters: OccurrenceFilters) {
  return queryOptions({
    queryKey: occurrenceKeys.list(filters),
    queryFn: () =>
      authFetch<Paginated<ExpenseOccurrence>>(`/occurrences?${occurrenceQueryString(filters)}`),
    placeholderData: (previous: Paginated<ExpenseOccurrence> | undefined) => previous,
  });
}

/**
 * Rilegge sia le spese sia le scadenze, sempre.
 *
 * Le due radici si muovono insieme in tutt'e due i versi: il server rigenera
 * le occorrenze quando la spesa cambia, e ricalcola `nextDueDate` e
 * `occurrenceCount` della spesa quando cambia un'occorrenza. Invalidarne una
 * sola lascerebbe a schermo un elenco che contraddice quello accanto.
 */
function useCrossInvalidation(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: expenseKeys.all }),
      queryClient.invalidateQueries({ queryKey: occurrenceKeys.all }),
    ]);
  };
}

export function useExpenseMutations() {
  const invalidate = useCrossInvalidation();

  const create = useMutation({
    mutationFn: (input: ExpenseFormInput) =>
      authFetch<Expense>('/expenses', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ExpenseFormInput }) =>
      authFetch<Expense>(`/expenses/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => authFetch<void>(`/expenses/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

export function useOccurrenceMutations() {
  const invalidate = useCrossInvalidation();

  /**
   * Una sola mutazione, e manda solo ciò che è cambiato.
   *
   * Il server tratta un campo assente come «lascialo com'è». Rimandare sempre
   * netto e lordo insieme farebbe sì che `resolveAmount` li tenga entrambi, e
   * correggere la sola aliquota non avrebbe alcun effetto.
   */
  const patch = useMutation({
    mutationFn: ({ id, patch: body }: { id: string; patch: OccurrencePatch }) =>
      authFetch<ExpenseOccurrence>(`/occurrences/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });

  return { patch };
}

/**
 * Il conteggio che accompagna il rifiuto di cancellare una spesa.
 *
 * Stesso codice `RESOURCE_IN_USE` di `inUseDetails`, forma diversa dei
 * dettagli: là due conteggi, qui uno. Sono due funzioni perché sono due
 * contratti, e una sola che accettasse entrambi restituirebbe un tipo su cui
 * chi chiama dovrebbe comunque fare una domanda in più.
 */
export function occurrencesInUse(error: unknown): ExpenseInUseDetails | null {
  if (!(error instanceof ApiError) || error.code !== RESOURCE_ERROR_CODES.inUse) return null;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return null;
  const { occurrences } = details as { occurrences?: unknown };
  if (typeof occurrences !== 'number') return null;
  return { occurrences };
}

/** Una spesa non esiste, o non è di chi la sta chiedendo. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
