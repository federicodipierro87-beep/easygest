import type { JobName, JobResult, Settings, SettingsPatch } from '@easygest/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { expenseKeys, occurrenceKeys } from './expenses';
import { notificationKeys } from './notifications';
import { authFetch } from './session';

/**
 * Le preferenze dell'utente e l'esecuzione manuale dei lavori.
 *
 * Stanno nello stesso modulo perché sono la stessa pagina: il pulsante «Esegui
 * adesso» è lì sotto proprio per verificare che gli anticipi appena salvati
 * facciano quello che si crede, e separarlo in un `lib/jobs.ts` da tre righe
 * significherebbe un file in più e nessuna informazione in più.
 */

export const settingsKeys = {
  all: ['settings'] as const,
};

export function settingsQueryOptions() {
  return queryOptions({
    queryKey: settingsKeys.all,
    queryFn: () => authFetch<Settings>('/settings'),
    // Una riga che cambia quando è l'utente stesso a cambiarla, e in quel caso
    // la mutazione invalida. Rileggerla a ogni montaggio sarebbe una chiamata
    // per niente.
    staleTime: 5 * 60_000,
  });
}

export function useSettingsMutations() {
  const queryClient = useQueryClient();

  /**
   * Cambiare il fuso rilegge anche spese e scadenze.
   *
   * «Quanti giorni mancano» e «è scaduta?» sono calcolati sul giorno
   * dell'utente: spostando il fuso il giorno può cambiare, e le due liste
   * resterebbero a schermo con i badge di ieri. È la stessa invalidazione
   * incrociata di `useExpenseMutations`, per la stessa ragione.
   */
  const update = useMutation({
    mutationFn: (patch: SettingsPatch) =>
      authFetch<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: async (updated, patch) => {
      queryClient.setQueryData(settingsKeys.all, updated);
      if (patch.timezone === undefined) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: expenseKeys.all }),
        queryClient.invalidateQueries({ queryKey: occurrenceKeys.all }),
      ]);
    },
  });

  return { update };
}

/**
 * «Esegui adesso».
 *
 * La risposta arriva a giro finito e porta i contatori, che sono la ragione per
 * cui il pulsante esiste: dopo il primo deploy si vuole sapere se le email sono
 * partite, non se la richiesta è andata a buon fine.
 *
 * Al termine si rilegge tutto ciò che il giro può aver mosso — notifiche,
 * scadenze, spese — perché un giro che marca pagate delle occorrenze e poi
 * lascia a schermo l'elenco di prima è peggio di un giro non eseguito: sembra
 * non aver fatto niente.
 */
export function useJobRun() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: JobName) => authFetch<JobResult>(`/jobs/${name}/run`, { method: 'POST' }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
        queryClient.invalidateQueries({ queryKey: occurrenceKeys.all }),
        queryClient.invalidateQueries({ queryKey: expenseKeys.all }),
      ]);
    },
  });
}
