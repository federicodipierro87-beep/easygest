import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { Booting } from '@/components/Booting';
import { useSession } from '@/hooks/use-session';

/**
 * Lascia passare solo chi ha una sessione.
 *
 * I tre stati vanno tenuti distinti. Trattare `loading` come «non
 * autenticato» manderebbe al login chiunque ricarichi la pagina, perché
 * all'avvio la risposta non è ancora arrivata: si vedrebbe il modulo di
 * accesso comparire e sparire da solo a ogni F5.
 *
 * La destinazione richiesta viene portata dietro nello stato della
 * navigazione, così dopo l'accesso si atterra dove si voleva andare invece che
 * sempre sulla home. `replace` evita che il tasto indietro riporti alla pagina
 * protetta appena rifiutata.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();

  if (session.status === 'loading') return <Booting />;

  if (session.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return children;
}
