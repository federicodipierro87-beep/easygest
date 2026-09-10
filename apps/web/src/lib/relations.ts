import type { Paginated } from '@easygest/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { queryString } from './resources';
import { authFetch } from './session';

/**
 * Le quattro anagrafiche viste come voci di una tendina.
 *
 * Non sono l'elenco paginato: qui non serve né cercare né impaginare, servono
 * i nomi. Quattro richieste da cento voci ciascuna, tenute buone cinque minuti
 * — un fornitore non cambia nome mentre si compila un modulo, e senza
 * `staleTime` ogni apertura della finestra ne farebbe quattro nuove.
 *
 * Si chiedono solo le attive. Una spesa vecchia può però puntare a un
 * fornitore archiviato dopo: quella tendina non lo conterrebbe, mostrerebbe il
 * vuoto, e salvare senza accorgersene scollegherebbe la spesa dal fornitore.
 * `withMissing` lo rimette in testa, ed è il motivo per cui esiste.
 */

export interface RelationOption {
  id: string;
  name: string;
}

/** Una riga vista da qui: il nome è tutto quello che serve. */
interface NamedRow {
  id: string;
  name: string;
}

/** I metodi di pagamento chiamano `label` quello che gli altri chiamano `name`. */
interface LabelledRow {
  id: string;
  label: string;
}

const PER_PAGE = '100';
const FIVE_MINUTES = 5 * 60 * 1000;

function optionsQuery<T>(resource: string, sort: string) {
  return queryOptions({
    // Chiave separata da quella degli elenchi: sono la stessa risorsa ma non
    // la stessa domanda, e una scrittura che invalida `['clients']` invalida
    // giustamente anche questa.
    queryKey: [resource, 'options'] as const,
    queryFn: () =>
      authFetch<Paginated<T>>(
        `/${resource}?${queryString([
          ['perPage', PER_PAGE],
          ['sort', sort],
        ])}`,
      ),
    staleTime: FIVE_MINUTES,
  });
}

export interface RelationOptions {
  vendors: RelationOption[];
  categories: RelationOption[];
  paymentMethods: RelationOption[];
  clients: RelationOption[];
  loading: boolean;
}

export function useRelationOptions(): RelationOptions {
  const vendors = useQuery(optionsQuery<NamedRow>('vendors', 'name'));
  const categories = useQuery(optionsQuery<NamedRow>('categories', 'name'));
  const paymentMethods = useQuery(optionsQuery<LabelledRow>('payment-methods', 'label'));
  const clients = useQuery(optionsQuery<NamedRow>('clients', 'name'));

  return {
    vendors: vendors.data?.items ?? [],
    categories: categories.data?.items ?? [],
    paymentMethods: (paymentMethods.data?.items ?? []).map((row) => ({
      id: row.id,
      name: row.label,
    })),
    clients: clients.data?.items ?? [],
    loading:
      vendors.isPending || categories.isPending || paymentMethods.isPending || clients.isPending,
  };
}

/**
 * Rimette in elenco il collegamento che la spesa ha e la tendina no.
 *
 * Capita per gli archiviati, che non compaiono nelle opzioni. Il nome arriva
 * dalla spesa stessa — l'API lo manda già accanto all'identificativo, proprio
 * per non dover chiedere quattro elenchi per disegnare una riga — e se anche
 * quello mancasse resta almeno chiaro che un collegamento c'è.
 */
export function withMissing(
  options: RelationOption[],
  id: string | null,
  name: string | null,
): RelationOption[] {
  if (id === null || options.some((option) => option.id === id)) return options;
  return [
    { id, name: name === null ? 'Collegamento archiviato' : `${name} (archiviato)` },
    ...options,
  ];
}
