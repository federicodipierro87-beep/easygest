import { useSyncExternalStore } from 'react';

import { getSessionSnapshot, subscribe, type SessionState } from '@/lib/session';

/**
 * Legge lo stato della sessione dallo store.
 *
 * Non c'è un context di React perché non servirebbe a niente: lo store è già
 * unico per l'applicazione, e un provider aggiungerebbe solo un livello da
 * attraversare. `useSyncExternalStore` esiste apposta per questo caso, e in
 * più evita che una lettura durante un rendering concorrente veda uno stato a
 * metà.
 *
 * Il terzo argomento è lo snapshot lato server: qui non c'è SSR, ma passarlo
 * costa una parola e non lascia il caso scoperto.
 */
export function useSession(): SessionState {
  return useSyncExternalStore(subscribe, getSessionSnapshot, getSessionSnapshot);
}
