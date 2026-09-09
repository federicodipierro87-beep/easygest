import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AppLayout } from './AppLayout';

function html(element: ReactElement, at: string): string {
  return renderToString(<MemoryRouter initialEntries={[at]}>{element}</MemoryRouter>);
}

describe('intelaiatura delle pagine autenticate', () => {
  it('porta a tutte le sezioni', () => {
    const markup = html(<AppLayout />, '/');

    expect(markup).toContain('href="/clienti"');
    expect(markup).toContain('href="/fornitori"');
    expect(markup).toContain('Esci');
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
