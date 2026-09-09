import { NavLink, Outlet } from 'react-router';

import { cn } from '@/lib/utils';

const PAGES = [
  { to: '/impostazioni/categorie', label: 'Categorie' },
  { to: '/impostazioni/metodi-di-pagamento', label: 'Metodi di pagamento' },
];

/**
 * Le pagine di configurazione, con il loro menù.
 *
 * Categorie e metodi di pagamento non sono anagrafiche che si consultano: si
 * sistemano una volta e poi si usano dai menù a tendina delle spese. Tenerle
 * nella barra principale accanto a «Clienti» e «Fornitori» darebbe lo stesso
 * peso a ciò che si apre ogni giorno e a ciò che si apre due volte l'anno.
 *
 * Il menù è a sinistra e non a schede in cima perché l'elenco crescerà — la
 * Fase 6 porta qui il regime fiscale e le aliquote — e delle schede che vanno
 * a capo sono peggio di una colonna.
 */
export function SettingsLayout() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Impostazioni</h1>

      <div className="flex flex-col gap-8 sm:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto text-sm sm:w-56 sm:flex-col sm:overflow-visible">
          {PAGES.map((page) => (
            <NavLink
              key={page.to}
              to={page.to}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-1.5 whitespace-nowrap transition-colors',
                  isActive ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {page.label}
            </NavLink>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
