import { Suspense, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';

import { NotificationsBell } from '@/components/NotificationsBell';
import { Button } from '@/components/ui/button';
import { useSession } from '@/hooks/use-session';
import { logout } from '@/lib/session';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { to: '/', label: 'Riepilogo' },
  // Senza `end`, resta evidenziata anche sul dettaglio di una spesa: da lì non
  // si è usciti dalla sezione, ci si è entrati dentro.
  { to: '/spese', label: 'Spese' },
  // Accanto alle spese e non dentro: sono le stesse righe lette al contrario —
  // là per contratto, qui per data — ed è la seconda lettura, non un dettaglio
  // della prima.
  { to: '/scadenze', label: 'Scadenze' },
  // Dopo le scadenze: sono le stesse righe lette una terza volta, sommate per
  // periodo invece che elencate. Chi guarda i report ci arriva da lì.
  { to: '/report', label: 'Report' },
  // Dopo il report e non prima: il report dice cos'è già costato, le previsioni
  // cosa costerà e cosa resta. È la stessa lettura spostata in avanti, e chi
  // arriva alle previsioni ci arriva avendo guardato l'anno scorso.
  { to: '/previsioni', label: 'Previsioni' },
  // Prima delle anagrafiche: si apre ogni volta che arriva una fattura, i
  // clienti e i fornitori si toccano quando ne arriva uno nuovo.
  { to: '/documenti', label: 'Documenti' },
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
      {/* `print:hidden` sulla classe e **non** un `header { display: none }` nel
          blocco di stampa: anche il titolo di `/report` è un `<header>`, e porta
          il periodo — cioè l'unica cosa che rende un foglio leggibile da solo.
          Un selettore globale lo cancellerebbe insieme a questo. */}
      <header className="bg-background sticky top-0 z-10 border-b print:hidden">
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
            {/* Prima del nome e non dopo «Esci»: è un comando che si usa, non
                un'etichetta, e sta accanto agli altri comandi. */}
            <NotificationsBell />
            {/* Il nome è la scorciatoia al proprio profilo, non l'unica via:
                su schermo stretto resta nascosto come prima, e
                `/impostazioni/profilo` si raggiunge comunque dal menù. */}
            <Link
              to="/impostazioni/profilo"
              className="text-muted-foreground hover:text-foreground hidden text-sm transition-colors sm:inline"
            >
              {session.user?.displayName ?? ''}
            </Link>
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

      {/*
        Il `Suspense` sta qui e non attorno alle rotte, così l'intestazione e il
        menù non spariscono mentre arriva il pezzo della pagina nuova: si vede
        la stessa riga di attesa che ogni pagina mostra già quando la sua query
        è in corso, e non una pagina bianca.
      */}
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Suspense fallback={<p className="text-muted-foreground text-sm">Caricamento…</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
