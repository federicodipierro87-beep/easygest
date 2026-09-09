import type { ZodType, z } from 'zod';

/**
 * Errore di validazione del corpo di una richiesta.
 *
 * `statusCode`, `code` e `details` sono i campi che l'error handler in
 * `app.ts` legge da un errore annotato: definirli qui significa che una
 * validazione fallita esce già nel formato d'errore dell'API, senza che ogni
 * rotta debba tradurla.
 */
export class ValidationError extends Error {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';

  constructor(readonly details: { field: string; message: string }[]) {
    super('Dati non validi');
    this.name = 'ValidationError';
  }
}

/**
 * Valida il corpo di una richiesta con uno schema Zod.
 *
 * Gli schemi arrivano da `@easygest/shared`, cioè sono gli stessi che usa il
 * frontend: la validazione lato server non è una ripetizione di quella lato
 * client, è l'unica che conta — l'altra serve solo a dare un errore prima di
 * fare il viaggio.
 *
 * Restituisce **tutti** gli errori, non solo il primo: correggere un campo per
 * volta, con un viaggio di rete ciascuno, è il modo peggiore di compilare un
 * form.
 */
export function parseBody<S extends ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        field: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * Come `parseBody`, ma per i parametri dell'URL.
 *
 * È la stessa funzione: cambia solo il nome, perché al punto di chiamata
 * `parseBody(schema, request.query)` si legge come uno sbaglio. Nella query
 * string ogni valore è una stringa, quindi gli schemi che passano di qui
 * devono convertire i numeri invece di aspettarseli già tali.
 */
export function parseQuery<S extends ZodType>(schema: S, query: unknown): z.infer<S> {
  return parseBody(schema, query);
}
