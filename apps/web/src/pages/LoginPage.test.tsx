import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Prova di accensione, non di comportamento.
 *
 * TypeScript e ESLint non si accorgono di un hook usato male, di un componente
 * di React Router adoperato fuori dal suo router o di uno snapshot mancante in
 * `useSyncExternalStore`: sono errori che compaiono al primo rendering. Qui il
 * rendering avviene davvero, e basta a farli emergere.
 *
 * Si usa `renderToString` e non un DOM finto perché per questo scopo il DOM non
 * serve: interessa che l'albero si costruisca, non che risponda ai click.
 */

function html(element: ReactElement): string {
  return renderToString(<MemoryRouter initialEntries={['/login']}>{element}</MemoryRouter>);
}

/**
 * Ricarica il modulo a ogni test: lo store di sessione tiene lo stato in
 * variabili di modulo, e `restoreSession` si esegue una volta sola per grafo.
 */
async function load() {
  vi.resetModules();
  const [page, session] = await Promise.all([import('./LoginPage'), import('@/lib/session')]);
  return { ...page, ...session };
}

beforeEach(() => {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ error: { code: 'INVALID_REFRESH_TOKEN', message: '', requestId: '' } }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pagina di accesso', () => {
  it('aspetta invece di mostrare il modulo finché non sa se c’è una sessione', async () => {
    const { LoginPage } = await load();

    // Nessun `restoreSession`: è lo stato in cui si trova l'app nell'istante in
    // cui parte. Mostrare qui il modulo vorrebbe dire farlo comparire e sparire
    // a chi è già dentro e ricarica la pagina.
    const markup = html(<LoginPage />);

    expect(markup).toContain('Caricamento');
    expect(markup).not.toContain('type="password"');
  });

  it('mostra il modulo quando la sessione non c’è', async () => {
    const { LoginPage, restoreSession } = await load();
    await restoreSession();

    const markup = html(<LoginPage />);

    expect(markup).toContain('Accedi');
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
  });

  it('marca i campi come credenziali per il gestore di password', async () => {
    const { LoginPage, restoreSession } = await load();
    await restoreSession();

    const markup = html(<LoginPage />);

    // Senza questi due attributi il browser non propone la password salvata e
    // non offre di salvarla: l'accesso andrebbe riscritto a mano ogni volta.
    // Il confronto ignora le maiuscole perché React serializza `autoComplete`
    // così com'è scritto nel JSX, e i nomi degli attributi HTML non le
    // distinguono.
    expect(markup).toMatch(/autocomplete="username"/i);
    expect(markup).toMatch(/autocomplete="current-password"/i);
  });

  it('collega ogni etichetta al suo campo', async () => {
    const { LoginPage, restoreSession } = await load();
    await restoreSession();

    const markup = html(<LoginPage />);

    // `useId` genera identificatori opachi: si verifica che ogni `for` di
    // un'etichetta corrisponda all'`id` di un campo esistente, non quali siano.
    //
    // Lo spazio prima di `id=` non è pignoleria: senza, `[^>]*id="` combacia
    // anche dentro `aria-invalid="false"`, e il confronto avverrebbe con la
    // stringa «false».
    const labelTargets = [...markup.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]);
    const inputIds = [...markup.matchAll(/<input[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);

    expect(labelTargets).toHaveLength(2);
    for (const target of labelTargets) {
      expect(inputIds).toContain(target);
    }
  });

  it('tiene pronta la regione degli errori prima che ci sia un errore', async () => {
    const { LoginPage, restoreSession } = await load();
    await restoreSession();

    // Un elemento con `role="alert"` inserito solo al momento dell'errore a
    // volte non viene annunciato dai lettori di schermo, perché non era lì da
    // osservare: deve esistere fin dall'inizio, vuoto.
    expect(html(<LoginPage />)).toContain('role="alert"');
  });
});
