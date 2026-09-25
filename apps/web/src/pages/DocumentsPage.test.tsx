import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { DocumentsPage } from './DocumentsPage';

/** Prova di accensione, come per le anagrafiche: che l'albero si costruisca. */
describe('archivio dei documenti', () => {
  it('mostra i comandi e lo stato di caricamento', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const markup = renderToString(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DocumentsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(markup).toContain('Documenti');
    expect(markup).toContain('Carica documento');
    expect(markup).toContain('Caricamento…');
  });
});
