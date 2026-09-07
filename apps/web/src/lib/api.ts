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
 * `credentials: 'include'` è obbligatorio perché il refresh token vive in un
 * cookie httpOnly su un dominio diverso da quello del frontend, ed è il motivo
 * per cui l'API non può usare un'origine CORS wildcard.
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
    // Rete irraggiungibile, DNS, oppure preflight CORS rifiutato: il browser
    // non espone il motivo, quindi il messaggio deve suggerire dove guardare.
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      `Impossibile raggiungere l'API su ${env.apiUrl}. Verifica che il backend sia ` +
        `avviato e che l'origine di questo sito sia elencata in CORS_ORIGINS.`,
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
