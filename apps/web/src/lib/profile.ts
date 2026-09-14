import type { AuthenticatedUser, ChangePasswordInput, ProfilePatch } from '@easygest/shared';
import { useMutation } from '@tanstack/react-query';

import { adoptUser, authFetch } from './session';

/**
 * Il proprio profilo: solo mutazioni, nessuna query.
 *
 * Manca di proposito un `userQueryOptions()` che legga `GET /auth/me`.
 * L'utente sta già nello store di sessione, che l'API ricostruisce dal cookie
 * a ogni avvio e rilegge dal database a ogni richiesta: una query parallela
 * duplicherebbe uno stato che esiste già e aprirebbe la domanda «quale dei due
 * è quello vero» ogni volta che i due divergono.
 */

export function useProfileMutations() {
  /**
   * La risposta riscrive l'utente in memoria, e non è un dettaglio: l'email
   * esce normalizzata, e il nome nell'intestazione resterebbe altrimenti quello
   * vecchio fino al ricaricamento — proprio nel punto in cui si è appena
   * cliccato per cambiarlo.
   */
  const update = useMutation({
    mutationFn: (patch: ProfilePatch) =>
      authFetch<AuthenticatedUser>('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: adoptUser,
  });

  /** Niente da invalidare: non esiste cache che riguardi una password. */
  const changePassword = useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      authFetch<void>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });

  return { update, changePassword };
}
