import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { SettingsLayout } from '@/components/SettingsLayout';

import { CategoriesPage } from './CategoriesPage';
import { PaymentMethodsPage } from './PaymentMethodsPage';

/**
 * Prova di accensione delle due pagine di configurazione.
 *
 * Come per le anagrafiche, qui non si prova il comportamento ma che l'albero
 * si costruisca. Su queste due pagine c'è però qualcosa in più da guardare: la
 * corrispondenza fra i nomi delle icone e i componenti che le disegnano è
 * scritta a mano, e una voce mancante non si vede fino al primo rendering di
 * una categoria che la usa.
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

describe('categorie', () => {
  it('mostra i comandi e lo stato di caricamento', () => {
    const markup = html(<CategoriesPage />);

    expect(markup).toContain('Categorie');
    expect(markup).toContain('Nuova categoria');
    expect(markup).toContain('Caricamento');
  });

  it('dice che le predefinite si archiviano invece di eliminarle', () => {
    // È l'unico posto in cui l'utente scopre la regola prima di sbatterci
    // contro premendo «elimina» su una voce del seed.
    const markup = html(<CategoriesPage />);

    expect(markup).toContain('archiviare');
  });
});

describe('metodi di pagamento', () => {
  it('mostra i comandi e le colonne che servono a riconoscere una riga', () => {
    const markup = html(<PaymentMethodsPage />);

    expect(markup).toContain('Metodi di pagamento');
    expect(markup).toContain('Nuovo metodo');
    expect(markup).toContain('Ultime 4');
    expect(markup).toContain('Scadenza');
  });

  it('annuncia che non conserva credenziali', () => {
    const markup = html(<PaymentMethodsPage />);

    expect(markup).toContain('Nessuna credenziale');
  });

  it('cerca anche nelle ultime quattro cifre', () => {
    // Il segnaposto è l'unico posto in cui si scopre che la ricerca non
    // guarda solo il nome.
    const markup = html(<PaymentMethodsPage />);

    expect(markup).toContain('ultime 4 cifre');
  });
});

describe('menù delle impostazioni', () => {
  it('elenca le due sezioni configurabili', () => {
    const markup = html(<SettingsLayout />);

    expect(markup).toContain('Impostazioni');
    expect(markup).toContain('Categorie');
    expect(markup).toContain('Metodi di pagamento');
    expect(markup).toContain('/impostazioni/categorie');
    expect(markup).toContain('/impostazioni/metodi-di-pagamento');
  });
});
