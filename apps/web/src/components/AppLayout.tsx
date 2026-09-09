import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';

import { Button } from '@/components/ui/button';
import { useSession } from '@/hooks/use-session';
import { logout } from '@/lib/session';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { to: '/', label: 'Riepilogo' },
  { to: '/clienti', label: 'Clienti' },
  { to: '/fornitori', label: 'Fornitori' },
  // Una voce sola per categorie e metodi di pagamento: si configurano una
  // volta e poi si usano dai menù a tendina delle spese, quindi non meritano
  // lo stesso spazio di ciò che si apre ogni giorno. Non avendo `end`, resta
  // evidenziata su entrambe le sotto-pagine, di cui è il prefisso.
  { to: '/impostazioni', label: 'Impostazioni' },
];

/**
 * Intelaiatura delle pagine autenticate.
 *
 * È una rotta di layout con un `Outlet` invece di un componente da avvolgere
 * attorno a ogni pagina: così l'intestazione non viene smontata e rimontata
 * passando da una sezione all'altra, e il menù non sfarfalla a ogni
 * navigazione.
 */
export function AppLayout() {
  const session = useSession();
  const [leaving, setLeaving] = useState(false);

  return (
    <div className="min-h-dvh">
      <header className="bg-background sticky top-0 z-10 border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-6">
          <span className="font-semibold tracking-tight">EasyGest</span>

          <nav className="flex items-center gap-1 text-sm">
            {SECTIONS.map((section) => (
              <NavLink
                key={section.to}
                to={section.to}
                // `end` solo sulla radice: senza, «/» risulterebbe attivo su
                // ogni percorso, perché ne è il prefisso.
                end={section.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-1.5 transition-colors',
                    isActive
                      ? 'bg-muted font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                }
              >
                {section.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-muted-foreground hidden text-sm sm:inline">
              {session.user?.displayName ?? ''}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={leaving}
              onClick={() => {
                setLeaving(true);
                // `logout` azzera comunque la sessione locale anche se la
                // chiamata fallisce, e da lì `RequireAuth` rimanda al login.
                void logout().finally(() => {
                  setLeaving(false);
                });
              }}
            >
              {leaving ? 'Uscita…' : 'Esci'}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
