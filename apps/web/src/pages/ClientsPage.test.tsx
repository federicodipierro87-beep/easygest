import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ClientsPage } from './ClientsPage';
import { VendorsPage } from './VendorsPage';

/**
 * Prova di accensione delle due anagrafiche.
 *
 * Come per la pagina di accesso, qui non si prova il comportamento ma che
 * l'albero si costruisca: una tabella con un `colSpan` sbagliato, un hook
 * chiamato fuori dal suo provider o un componente Radix montato senza il
 * contesto che si aspetta sono errori che compaiono al primo rendering e che
 * né TypeScript né ESLint vedono.
 *
 * Nessuna richiesta parte: `useQuery` non legge durante un rendering sul
 * server, quindi quello che si osserva è esattamente lo stato iniziale che
 * vede l'utente prima che l'API risponda.
 */

function html(element: ReactElement): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('anagrafica dei clienti', () => {
  it('mostra i comandi e lo stato di caricamento', () => {
    const markup = html(<ClientsPage />);

    expect(markup).toContain('Clienti');
    expect(markup).toContain('Nuovo cliente');
    expect(markup).toContain('Caricamento');
  });

  it('offre la ricerca sui campi con cui un cliente si ritrova davvero', () => {
    const markup = html(<ClientsPage />);

    // Il testo del segnaposto è l'unico posto in cui l'utente scopre che la
    // ricerca guarda anche la partita IVA.
    expect(markup).toContain('partita IVA');
    expect(markup).toContain('aria-label="Cerca"');
  });
});

describe('anagrafica dei fornitori', () => {
  it('mostra i comandi e le colonne che servono a disdire', () => {
    const markup = html(<VendorsPage />);

    expect(markup).toContain('Fornitori');
    expect(markup).toContain('Nuovo fornitore');
    expect(markup).toContain('Numero cliente');
    expect(markup).toContain('Pannello');
  });
});
