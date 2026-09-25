import { lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { AppLayout } from '@/components/AppLayout';
import { RequireAuth } from '@/components/RequireAuth';
import { LoginPage } from '@/pages/LoginPage';

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
 *
 * ## Il taglio passa dal login
 *
 * Tutto ciò che sta **dietro** l'accesso è caricato a richiesta, e solo il
 * login è statico. Il motivo è che chi arriva su `/login` non ha ancora una
 * sessione e non vedrà mai nessuna di queste pagine finché non ne ha una:
 * scaricare report, previsioni e cinque pagine di impostazioni per mostrare due
 * caselle e un bottone è il caso peggiore su una connessione lenta, ed è anche
 * il primo schermo che qualcuno vede del programma.
 *
 * `AppLayout` e `RequireAuth` restano statici di proposito: sono
 * l'intelaiatura, e caricarli a richiesta vorrebbe dire una pagina bianca al
 * posto dell'intestazione a ogni ingresso. Il `Suspense` sta dentro
 * `AppLayout`, attorno al solo `Outlet`, così il menù non sparisce mentre
 * arriva la pagina.
 */

const DashboardPage = lazy(async () => ({
  default: (await import('@/pages/DashboardPage')).DashboardPage,
}));
const ExpensesPage = lazy(async () => ({
  default: (await import('@/pages/ExpensesPage')).ExpensesPage,
}));
const ExpenseDetailPage = lazy(async () => ({
  default: (await import('@/pages/ExpenseDetailPage')).ExpenseDetailPage,
}));
const DueDatesPage = lazy(async () => ({
  default: (await import('@/pages/DueDatesPage')).DueDatesPage,
}));
const ReportPage = lazy(async () => ({
  default: (await import('@/pages/ReportPage')).ReportPage,
}));
const ForecastPage = lazy(async () => ({
  default: (await import('@/pages/ForecastPage')).ForecastPage,
}));
const DocumentsPage = lazy(async () => ({
  default: (await import('@/pages/DocumentsPage')).DocumentsPage,
}));
const ClientsPage = lazy(async () => ({
  default: (await import('@/pages/ClientsPage')).ClientsPage,
}));
const VendorsPage = lazy(async () => ({
  default: (await import('@/pages/VendorsPage')).VendorsPage,
}));
const SettingsLayout = lazy(async () => ({
  default: (await import('@/components/SettingsLayout')).SettingsLayout,
}));
const CategoriesPage = lazy(async () => ({
  default: (await import('@/pages/CategoriesPage')).CategoriesPage,
}));
const PaymentMethodsPage = lazy(async () => ({
  default: (await import('@/pages/PaymentMethodsPage')).PaymentMethodsPage,
}));
const AlertsSettingsPage = lazy(async () => ({
  default: (await import('@/pages/AlertsSettingsPage')).AlertsSettingsPage,
}));
const TaxSettingsPage = lazy(async () => ({
  default: (await import('@/pages/TaxSettingsPage')).TaxSettingsPage,
}));
const ProfileSettingsPage = lazy(async () => ({
  default: (await import('@/pages/ProfileSettingsPage')).ProfileSettingsPage,
}));

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
          <Route path="/spese" element={<ExpensesPage />} />
          <Route path="/spese/:id" element={<ExpenseDetailPage />} />
          <Route path="/scadenze" element={<DueDatesPage />} />
          <Route path="/report" element={<ReportPage />} />
          <Route path="/previsioni" element={<ForecastPage />} />
          <Route path="/documenti" element={<DocumentsPage />} />
          <Route path="/clienti" element={<ClientsPage />} />
          <Route path="/fornitori" element={<VendorsPage />} />
          {/*
            «Impostazioni» non è una pagina ma un contenitore: l'indirizzo
            nudo rimanda alla prima voce invece di mostrare una colonna di
            menù accanto al vuoto. `replace` tiene il tasto «indietro»
            funzionante — senza, tornare indietro rimbalzerebbe di nuovo qui.
          */}
          <Route path="/impostazioni" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/impostazioni/categorie" replace />} />
            <Route path="categorie" element={<CategoriesPage />} />
            <Route path="metodi-di-pagamento" element={<PaymentMethodsPage />} />
            <Route path="avvisi" element={<AlertsSettingsPage />} />
            <Route path="fisco" element={<TaxSettingsPage />} />
            <Route path="profilo" element={<ProfileSettingsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
