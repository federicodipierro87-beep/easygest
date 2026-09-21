import { NavLink, Outlet } from 'react-router';

import { cn } from '@/lib/utils';

const PAGES = [
  { to: '/impostazioni/categorie', label: 'Categorie' },
  { to: '/impostazioni/metodi-di-pagamento', label: 'Metodi di pagamento' },
  { to: '/impostazioni/avvisi', label: 'Avvisi' },
  // Accanto agli avvisi perché sono la stessa specie: due pagine che cambiano
  // il comportamento di un'altra: gli avvisi decidono cosa arriva per email, il
  // fisco decide con che numeri le previsioni fanno il conto. Categorie e metodi
  // di pagamento, invece, riempiono delle tendine.
  { to: '/impostazioni/fisco', label: 'Fisco' },
  // In coda e non in testa: la prima voce di questo elenco e il reindirizzamento
  // di `App.tsx` sono due cose separate, e metterci il profilo qui sopra
  // lascerebbe l'indirizzo nudo `/impostazioni` a puntare ancora alle categorie.
  { to: '/impostazioni/profilo', label: 'Profilo' },
];

/**
 * Le pagine di configurazione, con il loro menù.
 *
 * Categorie e metodi di pagamento non sono anagrafiche che si consultano: si
 * sistemano una volta e poi si usano dai menù a tendina delle spese. Tenerle
 * nella barra principale accanto a «Clienti» e «Fornitori» darebbe lo stesso
 * peso a ciò che si apre ogni giorno e a ciò che si apre due volte l'anno.
 *
 * Il menù è a sinistra e non a schede in cima perché l'elenco sarebbe cresciuto,
 * e delle schede che vanno a capo sono peggio di una colonna. È cresciuto: il
 * regime fiscale e le aliquote sono la quinta voce.
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
