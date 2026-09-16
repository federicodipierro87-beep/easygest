import type { DashboardSummary } from '@easygest/shared';
import { queryOptions } from '@tanstack/react-query';

import { authFetch } from './session';

/**
 * Il riepilogo della dashboard.
 *
 * Una chiave sola e nessun filtro, perché la rotta non ha parametri: la
 * dashboard è «oggi». Non c'è quindi un `list(filters)` da comporre, e
 * `dashboardKeys.all` è insieme la radice da invalidare e la chiave da leggere.
 */
export const dashboardKeys = {
  all: ['dashboard'] as const,
};

export function dashboardSummaryQueryOptions() {
  return queryOptions({
    queryKey: dashboardKeys.all,
    queryFn: () => authFetch<DashboardSummary>('/dashboard'),
    /**
     * Un minuto di validità, ma si rilegge tornando sulla scheda.
     *
     * Le due impostazioni rispondono a momenti diversi. Lo `staleTime` copre
     * il girovagare fra le pagine, dove rileggere quattro sezioni a ogni
     * ritorno sarebbe una richiesta per niente. Il `refetchOnWindowFocus`
     * copre il caso che conta: la scheda lasciata aperta la sera e ritrovata
     * la mattina, dopo che il cron ha marcato pagate delle scadenze. Senza,
     * l'agenda di ieri resterebbe lì a sembrare quella di oggi.
     */
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
