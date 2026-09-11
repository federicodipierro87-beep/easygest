import type { Settings } from '@easygest/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { SettingsLayout } from '@/components/SettingsLayout';
import { settingsKeys } from '@/lib/settings';

import { AlertsSettingsPage } from './AlertsSettingsPage';
import { CategoriesPage } from './CategoriesPage';
import { PaymentMethodsPage } from './PaymentMethodsPage';

/**
 * Prova di accensione delle pagine di configurazione.
 *
 * Come per le anagrafiche, qui non si prova il comportamento ma che l'albero si
 * costruisca. Su queste pagine c'è però qualcosa in più da guardare: la
 * corrispondenza fra i nomi delle icone e i componenti che le disegnano è
 * scritta a mano, e una voce mancante non si vede fino al primo rendering di
 * una categoria che la usa; e la regola dell'anticipo più vicino, che se sparisse
 * dal testo lascerebbe una casella con dentro «30, 7, 1» a far credere che
 * arrivino tre email.
 */

function html(element: ReactElement, seed?: (client: QueryClient) => void): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Le impostazioni già in cache.
 *
 * Senza, `renderToString` fotografa la pagina mentre carica e del modulo non si
 * vedrebbe niente: la prova di accensione proverebbe l'esistenza della scritta
 * «Caricamento…». Riempire la cache prima è il modo più corto per far montare
 * il modulo vero senza rete e senza mock del `fetch`.
 */
const SETTINGS: Settings = {
  taxRegime: 'FORFETTARIO',
  substituteTaxRateBp: 500,
  profitabilityCoefficientBp: 7800,
  inpsRateBp: 2607,
  defaultVatRateBp: 2200,
  baseCurrency: 'EUR',
  timezone: 'Europe/Rome',
  reminderDaysBefore: [30, 7, 1],
  cancellationReminderDaysBefore: [60, 30, 15],
  digestEnabled: true,
  digestDayOfWeek: 1,
  updatedAt: '2027-03-15T06:00:00.000Z',
};

function withSettings(client: QueryClient): void {
  client.setQueryData(settingsKeys.all, SETTINGS);
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

describe('avvisi', () => {
  it('mostra i due campi degli anticipi e spiega la regola', () => {
    // La regola dell'anticipo più vicino non si indovina guardando una
    // casella con dentro «30, 7, 1»: chi la legge si aspetta tre email.
    const markup = html(<AlertsSettingsPage />, withSettings);

    expect(markup).toContain('Promemoria delle scadenze');
    expect(markup).toContain('Promemoria delle disdette');
    expect(markup).toContain('anticipo più vicino');
  });

  it('offre di far partire il controllo a mano', () => {
    const markup = html(<AlertsSettingsPage />, withSettings);

    expect(markup).toContain('Controlli automatici');
    expect(markup).toContain('Esegui adesso');
  });
});

describe('menù delle impostazioni', () => {
  it('elenca le sezioni configurabili', () => {
    const markup = html(<SettingsLayout />);

    expect(markup).toContain('Impostazioni');
    expect(markup).toContain('Categorie');
    expect(markup).toContain('Metodi di pagamento');
    expect(markup).toContain('/impostazioni/categorie');
    expect(markup).toContain('/impostazioni/metodi-di-pagamento');
    expect(markup).toContain('/impostazioni/avvisi');
  });
});
