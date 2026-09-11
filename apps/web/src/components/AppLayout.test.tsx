import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AppLayout } from './AppLayout';

/**
 * Il client delle query serve da quando l'intestazione porta la campanella, che
 * interroga il conteggio delle non lette.
 */
function html(element: ReactElement, at: string): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[at]}>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('intelaiatura delle pagine autenticate', () => {
  it('porta a tutte le sezioni', () => {
    const markup = html(<AppLayout />, '/');

    expect(markup).toContain('href="/clienti"');
    expect(markup).toContain('href="/fornitori"');
    expect(markup).toContain('Esci');
  });

  it('mostra la campanella, con il numero detto a parole', () => {
    // Un pallino rosso non si legge con lo screen reader: l'unica informazione
    // che il badge porta dev'essere anche nell'etichetta.
    const markup = html(<AppLayout />, '/');

    expect(markup).toContain('Notifiche: nessuna da leggere');
  });

  it('segna come attiva solo la sezione in cui ci si trova', () => {
    /**
     * Senza `end` sulla radice ogni percorso risulterebbe dentro «/», perché
     * ne è il prefisso: le tre voci sarebbero evidenziate tutte insieme e il
     * menù smetterebbe di dire dove si è.
     */
    const onClients = html(<AppLayout />, '/clienti');
    const active = [...onClients.matchAll(/aria-current="page"/g)];

    expect(active).toHaveLength(1);
  });
});
