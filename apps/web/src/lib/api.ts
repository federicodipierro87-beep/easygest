import { env } from './env';

/** Forma dell'errore restituita dall'API, definita in apps/api/src/app.ts. */
interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/**
 * Chiamata all'API.
 *
 * Le richieste partono verso un percorso relativo (`/api/...`), che il dev
 * server di Vite in sviluppo e Netlify in produzione inoltrano al backend: per
 * il browser sono richieste same-origin, e il cookie di sessione è first-party.
 *
 * `credentials: 'include'` sarebbe superfluo nel caso same-origin, dove i cookie
 * partono comunque. Resta esplicito perché continui a funzionare se
 * `VITE_API_URL` viene puntata a un backend su un altro host.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${env.apiUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    });
  } catch {
    // Il browser non espone il motivo di un fallimento di rete, quindi il
    // messaggio deve dire dove guardare invece di limitarsi a «failed to fetch».
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      `Impossibile raggiungere l'API su ${env.apiUrl}. In locale verifica che il ` +
        `backend sia avviato sulla porta attesa dal proxy di Vite.`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (isApiErrorBody(payload)) {
      throw new ApiError(
        response.status,
        payload.error.code,
        payload.error.message,
        payload.error.requestId,
      );
    }
    throw new ApiError(response.status, 'UNEXPECTED_ERROR', `Errore ${String(response.status)}`);
  }

  return payload as T;
}
