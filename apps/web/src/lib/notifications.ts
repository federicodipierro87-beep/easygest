import type { Notification, Paginated, UnreadCount } from '@easygest/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { queryString } from './resources';
import { authFetch } from './session';

/**
 * Il livello dati della campanella.
 *
 * Due query separate e non una: il conteggio è l'unica cosa che viaggia a
 * popover chiuso, e deve poter essere riletto da solo. L'elenco si carica solo
 * all'apertura (`enabled: open` dal componente), perché venticinque righe
 * scaricate ogni minuto per mostrarne il numero sarebbero venticinque righe
 * sprecate ogni minuto.
 */

/** Quante notifiche mostra il popover: quello che ci sta senza scorrere troppo. */
export const NOTIFICATIONS_PER_PAGE = 10;

/**
 * Ogni quanto si rilegge il badge.
 *
 * Sessanta secondi e non meno: i dati sotto cambiano una volta al giorno, e
 * interrogare più spesso sarebbe rumore. Non di più, però, perché dopo un
 * «Esegui adesso» il numero deve cambiare entro un tempo che sembri una
 * conseguenza del clic.
 *
 * `refetchOnWindowFocus` copre il caso vero — si torna sulla scheda la mattina
 * e il numero è già giusto — mentre `refetchIntervalInBackground` resta al suo
 * `false` di default, così una scheda dimenticata non interroga l'API tutta la
 * notte. Niente SSE né WebSocket per un numero che si muove una volta al giorno.
 */
const UNREAD_POLL_MS = 60_000;

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (unreadOnly: boolean) => ['notifications', 'list', unreadOnly] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
};

export function unreadCountQueryOptions() {
  return queryOptions({
    queryKey: notificationKeys.unreadCount,
    queryFn: () => authFetch<UnreadCount>('/notifications/unread-count'),
    refetchInterval: UNREAD_POLL_MS,
    refetchOnWindowFocus: true,
    // Metà dell'intervallo: un rientro sulla scheda poco dopo un giro automatico
    // rilegge, un rientro subito dopo un clic no.
    staleTime: UNREAD_POLL_MS / 2,
  });
}

export function notificationListQueryOptions(unreadOnly: boolean) {
  return queryOptions({
    queryKey: notificationKeys.list(unreadOnly),
    queryFn: () =>
      authFetch<Paginated<Notification>>(
        `/notifications?${queryString([
          ['perPage', String(NOTIFICATIONS_PER_PAGE)],
          ['unread', unreadOnly ? 'true' : undefined],
        ])}`,
      ),
  });
}

/**
 * Segnare letta una notifica, o tutte.
 *
 * Senza aggiornamento ottimistico, coerentemente con il debito già dichiarato
 * per il resto dell'applicazione: l'elenco si rilegge dopo la risposta. Qui
 * costa ancora meno che altrove, perché il clic chiude subito il popover e la
 * rilettura avviene mentre non la si sta guardando.
 *
 * Si invalida la radice intera e non le due chiavi a mano: leggere una notifica
 * cambia il conteggio *e* la riga nell'elenco, in tutt'e due le varianti del
 * filtro.
 */
export function useNotificationMutations() {
  const queryClient = useQueryClient();
  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
  };

  const markRead = useMutation({
    mutationFn: (id: string) =>
      authFetch<Notification>(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  const markAllRead = useMutation({
    mutationFn: () => authFetch<{ updated: number }>('/notifications/read-all', { method: 'POST' }),
    onSuccess: invalidate,
  });

  return { markRead, markAllRead };
}
