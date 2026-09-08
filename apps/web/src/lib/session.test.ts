import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lo store di sessione è scritto senza React apposta: quello che c'è da
 * sbagliare qui è la concorrenza, non il rendering.
 *
 * Il punto delicato è che l'API ruota i refresh token e tratta il riuso di uno
 * già consumato come un furto, revocando l'intera famiglia. Basta quindi che
 * due richieste scadute chiamino `/auth/refresh` insieme perché la sessione si
 * chiuda da sola. È un difetto che non si manifesta quasi mai a mano — servono
 * due chiamate sovrapposte — e sistematicamente in produzione, dove la
 * dashboard ne lancia parecchie insieme.
 */

interface Recorded {
  path: string;
  method: string;
  authorization: string | undefined;
}

const API = '/api';

let recorded: Recorded[] = [];
let handlers: Map<string, () => Promise<Response>>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionBody(accessToken: string, expiresInSeconds = 900) {
  return {
    accessToken,
    expiresInSeconds,
    user: { id: 'u1', email: 'tizio@example.com', displayName: 'Tizio' },
  };
}

function apiError(code: string) {
  return { error: { code, message: code, requestId: 'req-test' } };
}

/** Promessa che si risolve quando lo decide il test, non prima. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function route(path: string, handler: () => Promise<Response>): void {
  handlers.set(path, handler);
}

function countOf(path: string): number {
  return recorded.filter((call) => call.path === path).length;
}

/** Lascia girare le microtask in sospeso senza far avanzare nulla d'altro. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Ricarica il modulo a ogni test.
 *
 * Lo store tiene il token e lo stato in variabili di modulo: senza questo il
 * risultato di un test dipenderebbe da quelli eseguiti prima. `ApiError` viene
 * riletto dallo stesso grafo appena creato, altrimenti sarebbe una classe
 * diversa da quella che lo store lancia e `instanceof` fallirebbe.
 */
async function loadSession() {
  vi.resetModules();
  const [session, api] = await Promise.all([import('./session'), import('./api')]);
  return { ...session, ApiError: api.ApiError };
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API);
  recorded = [];
  handlers = new Map();

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const path = input.startsWith(API) ? input.slice(API.length) : input;
      const headers = (init.headers ?? {}) as Record<string, string>;
      recorded.push({
        path,
        method: init.method ?? 'GET',
        authorization: headers.Authorization,
      });

      const handler = handlers.get(path);
      if (!handler) throw new Error(`Nessun handler per ${path}`);
      return handler();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('rinnovo dell’access token', () => {
  it('ne esegue uno solo anche se tre richieste scadono insieme', async () => {
    const gate = deferred<void>();
    route('/auth/refresh', async () => {
      await gate.promise;
      return json(200, sessionBody('token-nuovo'));
    });
    route('/a', () => Promise.resolve(json(200, { ok: 'a' })));
    route('/b', () => Promise.resolve(json(200, { ok: 'b' })));
    route('/c', () => Promise.resolve(json(200, { ok: 'c' })));

    const { authFetch } = await loadSession();

    // Nessun token in memoria: tutte e tre devono rinnovare prima di partire.
    const all = Promise.all([authFetch('/a'), authFetch('/b'), authFetch('/c')]);
    await flush();

    // Il cuore della faccenda. Se qui fossero tre, in produzione le ultime due
    // ripresenterebbero un cookie già consumato e l'API revocherebbe tutto.
    expect(countOf('/auth/refresh')).toBe(1);

    gate.resolve();
    await expect(all).resolves.toEqual([{ ok: 'a' }, { ok: 'b' }, { ok: 'c' }]);

    // E tutte e tre devono aver usato il token appena ottenuto.
    const bearers = recorded
      .filter((call) => ['/a', '/b', '/c'].includes(call.path))
      .map((call) => call.authorization);
    expect(bearers).toEqual(['Bearer token-nuovo', 'Bearer token-nuovo', 'Bearer token-nuovo']);
  });

  it('rinnova e riprova una sola volta quando l’API risponde 401', async () => {
    route('/auth/login', () => Promise.resolve(json(200, sessionBody('token-1'))));
    route('/auth/refresh', () => Promise.resolve(json(200, sessionBody('token-2'))));

    let chiamate = 0;
    route('/protetta', () => {
      chiamate += 1;
      return Promise.resolve(
        chiamate === 1 ? json(401, apiError('UNAUTHENTICATED')) : json(200, { ok: true }),
      );
    });

    const { login, authFetch } = await loadSession();
    await login({ email: 'tizio@example.com', password: 'password-lunghissima' });

    await expect(authFetch('/protetta')).resolves.toEqual({ ok: true });

    const tentativi = recorded.filter((call) => call.path === '/protetta');
    expect(tentativi.map((call) => call.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
    expect(countOf('/auth/refresh')).toBe(1);
  });

  it('non rinnova di nuovo se un’altra richiesta ha già rinnovato nel frattempo', async () => {
    route('/auth/login', () => Promise.resolve(json(200, sessionBody('token-1'))));
    route('/auth/refresh', () => Promise.resolve(json(200, sessionBody('token-2'))));

    // `/lenta` incassa un 401 che consegniamo noi, dopo che `/veloce` ha già
    // fatto rinnovare il token.
    const gate = deferred<void>();
    let lente = 0;
    route('/lenta', async () => {
      lente += 1;
      if (lente === 1) {
        await gate.promise;
        return json(401, apiError('UNAUTHENTICATED'));
      }
      return json(200, { ok: 'lenta' });
    });

    let veloci = 0;
    route('/veloce', () => {
      veloci += 1;
      return Promise.resolve(
        veloci === 1 ? json(401, apiError('UNAUTHENTICATED')) : json(200, { ok: 'veloce' }),
      );
    });

    const { login, authFetch } = await loadSession();
    await login({ email: 'tizio@example.com', password: 'password-lunghissima' });

    const lenta = authFetch('/lenta');
    await flush();

    await expect(authFetch('/veloce')).resolves.toEqual({ ok: 'veloce' });
    expect(countOf('/auth/refresh')).toBe(1);

    gate.resolve();
    await expect(lenta).resolves.toEqual({ ok: 'lenta' });

    // Il secondo tentativo di `/lenta` parte col token già valido: rinnovare
    // ancora brucerebbe un giro di rotazione per niente.
    expect(countOf('/auth/refresh')).toBe(1);
    expect(recorded.filter((call) => call.path === '/lenta').map((c) => c.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });
});

describe('ripresa della sessione all’avvio', () => {
  it('ricostruisce l’utente dal cookie', async () => {
    route('/auth/refresh', () => Promise.resolve(json(200, sessionBody('token-1'))));

    const { restoreSession, getSessionSnapshot } = await loadSession();
    expect(getSessionSnapshot().status).toBe('loading');

    await restoreSession();

    const state = getSessionSnapshot();
    expect(state.status).toBe('authenticated');
    expect(state.user?.email).toBe('tizio@example.com');
  });

  it('chiamata due volte rinnova una volta sola', async () => {
    route('/auth/refresh', () => Promise.resolve(json(200, sessionBody('token-1'))));

    const { restoreSession } = await loadSession();

    // `StrictMode` monta gli effetti due volte in sviluppo: se ognuna facesse
    // partire un rinnovo, il secondo userebbe un cookie appena ruotato.
    await Promise.all([restoreSession(), restoreSession()]);

    expect(countOf('/auth/refresh')).toBe(1);
  });

  it('resta anonima se il cookie non vale più', async () => {
    route('/auth/refresh', () => Promise.resolve(json(401, apiError('INVALID_REFRESH_TOKEN'))));

    const { restoreSession, getSessionSnapshot } = await loadSession();
    await restoreSession();

    expect(getSessionSnapshot().status).toBe('anonymous');
  });
});

describe('guasti distinti dalla sessione finita', () => {
  it('non chiude la sessione se il rinnovo fallisce per un errore del server', async () => {
    route('/auth/login', () => Promise.resolve(json(200, sessionBody('token-1', -1))));
    route('/auth/refresh', () => Promise.resolve(json(500, apiError('INTERNAL_ERROR'))));

    const { login, authFetch, getSessionSnapshot, ApiError } = await loadSession();
    // `expiresInSeconds` negativo: il token nasce già scaduto, quindi la
    // richiesta successiva prova a rinnovare prima ancora di partire.
    await login({ email: 'tizio@example.com', password: 'password-lunghissima' });
    expect(getSessionSnapshot().status).toBe('authenticated');

    await expect(authFetch('/protetta')).rejects.toBeInstanceOf(ApiError);

    // Un 500 è un guasto dell'API, non una sessione scaduta: buttare fuori
    // l'utente qui vorrebbe dire fargli riscrivere la password per un errore
    // che non lo riguarda.
    expect(getSessionSnapshot().status).toBe('authenticated');
  });

  it('esce comunque se la chiamata di logout fallisce', async () => {
    route('/auth/login', () => Promise.resolve(json(200, sessionBody('token-1'))));
    route('/auth/logout', () => Promise.reject(new Error('rete giù')));

    const { login, logout, getSessionSnapshot } = await loadSession();
    await login({ email: 'tizio@example.com', password: 'password-lunghissima' });

    await expect(logout()).rejects.toThrow();
    expect(getSessionSnapshot().status).toBe('anonymous');
  });
});
