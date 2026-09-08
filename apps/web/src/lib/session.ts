import { AUTH_ERROR_CODES, type AuthSession, type AuthenticatedUser } from '@easygest/shared';
import type { LoginInput } from '@easygest/shared';

import { ApiError, apiFetch } from './api';

/**
 * Stato della sessione.
 *
 * `loading` non è un dettaglio estetico: al primo caricamento non sappiamo
 * ancora se esiste una sessione, perché la risposta sta in un cookie httpOnly
 * che il JavaScript non può leggere. Bisogna chiederlo all'API. Senza questo
 * terzo stato l'app mostrerebbe la pagina di login per un istante a ogni
 * ricarica, e il rimbalzo si vedrebbe.
 */
export type SessionState =
  | { status: 'loading'; user: null }
  | { status: 'anonymous'; user: null }
  | { status: 'authenticated'; user: AuthenticatedUser };

/**
 * Quanto prima della scadenza consideriamo l'access token già morto.
 *
 * L'orologio del browser e quello del server non coincidono, e fra il momento
 * in cui decidiamo di usare il token e quello in cui l'API lo verifica passa
 * la latenza della rete. Con un token da quindici minuti, spenderne quindici
 * secondi per non incassare un 401 evitabile è un ottimo cambio.
 */
const EXPIRY_SKEW_MS = 15_000;

const LOADING: SessionState = { status: 'loading', user: null };
const ANONYMOUS: SessionState = { status: 'anonymous', user: null };

let state: SessionState = LOADING;

/**
 * L'access token vive solo qui, in memoria.
 *
 * Non in `localStorage`: quello che ci si mette è leggibile da qualunque
 * script finisca nella pagina, e sopravvive alla chiusura della scheda. Non
 * serve nemmeno, perché la sessione si ricostruisce dal cookie httpOnly a ogni
 * avvio — il che significa che un token rubato dura al massimo quanto la
 * scheda aperta.
 */
let accessToken: string | null = null;
let expiresAt = 0;

const listeners = new Set<() => void>();

function setState(next: SessionState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `useSyncExternalStore` confronta gli snapshot per identità e rende di nuovo
 * finché cambiano: restituire un oggetto nuovo a ogni chiamata sarebbe un
 * ciclo infinito. Per questo `state` viene sostituito solo quando cambia
 * davvero.
 */
export function getSessionSnapshot(): SessionState {
  return state;
}

function adoptSession(session: AuthSession): void {
  accessToken = session.accessToken;
  expiresAt = Date.now() + session.expiresInSeconds * 1000 - EXPIRY_SKEW_MS;
  setState({ status: 'authenticated', user: session.user });
}

function forgetSession(): void {
  accessToken = null;
  expiresAt = 0;
  setState(ANONYMOUS);
}

let refreshInFlight: Promise<string | null> | null = null;

async function performRefresh(): Promise<string | null> {
  try {
    const session = await apiFetch<AuthSession>('/auth/refresh', { method: 'POST' });
    adoptSession(session);
    return session.accessToken;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // Il cookie manca, è scaduto o è stato revocato: non c'è più sessione.
      forgetSession();
      return null;
    }
    // Rete irraggiungibile o API rotta: è un guasto, non una sessione finita.
    // Buttare fuori l'utente qui vorrebbe dire fargli riscrivere la password
    // per colpa di trenta secondi di wifi ballerino.
    throw error;
  }
}

/**
 * Rinnova l'access token, una volta sola anche se lo chiedono in dieci.
 *
 * L'API ruota i refresh token: ogni rinnovo consuma quello nel cookie e ne
 * emette un altro, e ripresentare un token già consumato viene trattato come
 * furto — l'intera famiglia viene revocata. Se tre query scadessero insieme e
 * ognuna chiamasse `/auth/refresh` per conto suo, la prima consumerebbe il
 * cookie e le altre due lo ripresenterebbero: l'API le vedrebbe come un riuso
 * e chiuderebbe la sessione. L'utente si ritroverebbe scollegato a caso, con
 * più probabilità quanto più l'app diventa veloce nel caricare i dati.
 *
 * Da qui il singolo volo: chi arriva mentre un rinnovo è in corso aspetta
 * quello, e nessuno emette una seconda richiesta.
 */
function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function withBearer(init: RequestInit, token: string): RequestInit {
  return {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  };
}

function sessionExpired(): ApiError {
  return new ApiError(
    401,
    AUTH_ERROR_CODES.unauthenticated,
    'Sessione scaduta. Accedi di nuovo per continuare.',
  );
}

/**
 * Chiamata autenticata all'API.
 *
 * Rinnova prima di partire se il token è scaduto, e riprova una volta sola se
 * l'API risponde comunque 401 — può succedere se la sessione è stata revocata
 * altrove, o se i due orologi divergono più del margine previsto.
 *
 * Il corpo viene riusato tal quale nel secondo tentativo: qui passano sempre
 * stringhe JSON, che si possono rileggere. Uno `ReadableStream` no, ma non ne
 * mandiamo — gli allegati andranno diretti su R2 con una URL firmata.
 */
export async function authFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let token = accessToken;

  if (token === null || Date.now() >= expiresAt) {
    token = await refreshAccessToken();
  }
  if (token === null) throw sessionExpired();

  const used = token;
  try {
    return await apiFetch<T>(path, withBearer(init, used));
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;

    /**
     * Se nel frattempo qualcun altro ha già rinnovato, il token in memoria è
     * diverso da quello appena rifiutato: basta riprovare con quello, senza
     * consumare un altro giro di rotazione.
     */
    const fresh =
      accessToken !== null && accessToken !== used ? accessToken : await refreshAccessToken();
    if (fresh === null) throw sessionExpired();

    return apiFetch<T>(path, withBearer(init, fresh));
  }
}

let restoring: Promise<void> | null = null;

/**
 * Ricostruisce la sessione dal cookie all'avvio.
 *
 * Chiamarla più volte non fa danni: `StrictMode` in sviluppo monta gli effetti
 * due volte apposta, e senza questa promessa condivisa partirebbero due
 * rinnovi.
 */
export function restoreSession(): Promise<void> {
  restoring ??= refreshAccessToken()
    .then(() => undefined)
    .catch(() => {
      // Un guasto di rete all'avvio non ci dice se una sessione esista. Non
      // potendo saperlo mostriamo il login: il tentativo di accesso fallirà a
      // sua volta, ma con un messaggio che spiega che l'API non risponde.
      forgetSession();
    });
  return restoring;
}

export async function login(input: LoginInput): Promise<void> {
  const session = await apiFetch<AuthSession>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  adoptSession(session);
}

/**
 * Chiude la sessione localmente in ogni caso.
 *
 * Se la chiamata fallisce il cookie resta valido sul server, ma l'utente ha
 * chiesto di uscire e deve uscire: tenerlo dentro perché la rete è caduta
 * sarebbe la risposta sbagliata alla domanda sbagliata.
 */
export async function logout(): Promise<void> {
  try {
    await apiFetch<void>('/auth/logout', { method: 'POST' });
  } finally {
    forgetSession();
  }
}
