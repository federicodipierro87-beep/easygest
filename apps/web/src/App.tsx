import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { AppLayout } from '@/components/AppLayout';
import { RequireAuth } from '@/components/RequireAuth';
import { ClientsPage } from '@/pages/ClientsPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { LoginPage } from '@/pages/LoginPage';
import { VendorsPage } from '@/pages/VendorsPage';

/**
 * Rotte dell'applicazione.
 *
 * `BrowserRouter` e non `HashRouter`: gli indirizzi restano puliti, ma questo
 * richiede che il server risponda con `index.html` per qualunque percorso,
 * altrimenti ricaricare `/login` darebbe un 404. In sviluppo lo fa Vite, in
 * produzione la regola di rewrite in `netlify.toml`.
 *
 * Qualunque percorso sconosciuto rimanda alla home invece di mostrare una
 * pagina di errore: finché le sezioni sono due, un 404 sarebbe quasi sempre un
 * refuso nella barra degli indirizzi.
 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/*
          Una sola rotta di layout attorno a tutte le pagine autenticate: il
          controllo della sessione sta in un posto, e aggiungere una sezione
          non richiede di ricordarsi di proteggerla.
        */}
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<DashboardPage />} />
          <Route path="/clienti" element={<ClientsPage />} />
          <Route path="/fornitori" element={<VendorsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
