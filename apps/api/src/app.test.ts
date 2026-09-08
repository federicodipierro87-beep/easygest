import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { buildApp } from './app';
import { type Env, parseEnv } from './config/env';

/**
 * Verifica il *formato* delle risposte di errore, non la logica che le produce.
 *
 * Il frontend si comporta diversamente a seconda di `error.code`: distingue
 * «credenziali sbagliate» da «aspetta e riprova» da «il server è rotto». È un
 * contratto, e come tutti i contratti si rompe in silenzio — un 429 uscito
 * come `INTERNAL_ERROR` non fa fallire niente qui dentro, fa solo comparire
 * «errore imprevisto» all'utente al posto di «troppi tentativi».
 *
 * Serve `app.inject()` e non una vera richiesta HTTP: attraversa la stessa
 * catena di hook e lo stesso error handler senza aprire una porta.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

describe('formato delle risposte di errore', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(env);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('risponde a una rotta inesistente con NOT_FOUND, non con una pagina HTML', async () => {
    const response = await app.inject({ method: 'GET', url: '/non-esiste' });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
    // Il `requestId` è ciò che lega la risposta alla riga di log corrispondente:
    // senza, una segnalazione dell'utente non è rintracciabile.
    expect(body.error.requestId).not.toBe('');
  });

  it('elenca tutti i campi sbagliati, non solo il primo', async () => {
    // Un form che si corregge un campo alla volta è il motivo per cui
    // `parseBody` restituisce l'intero elenco degli errori di Zod.
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'non-una-email' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; details: { field: string }[] } }>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.map((detail) => detail.field)).toContain('password');
  });

  it('accetta un POST senza corpo qualunque Content-Type dichiari', async () => {
    /**
     * La rewrite di Netlify aggiunge un `Content-Type` ai POST che il browser
     * manda senza. Finché Fastify non aveva un parser per quel tipo,
     * `/auth/refresh` rispondeva 415 attraverso il proxy e 401 chiamando
     * l'API direttamente: la sessione non si sarebbe rinnovata mai, e in
     * sviluppo non si sarebbe visto niente.
     */
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('MISSING_REFRESH_TOKEN');
  });

  it('rifiuta invece un corpo vero in un formato che non sa leggere', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { 'content-type': 'application/xml' },
      payload: '<refresh/>',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('non lascia passare una richiesta senza token', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });
});

describe('limite di tentativi sul login', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Istanza dedicata: il contatore del rate limit sta in memoria e vive
    // quanto l'applicazione, quindi condividerla vorrebbe dire far dipendere
    // l'esito dall'ordine dei test.
    app = await buildApp(env);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('risponde 429 con codice RATE_LIMITED oltre il quinto tentativo', async () => {
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nessuno@example.com', password: 'password-sbagliata' },
      });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).statusCode).toBe(401);
    }

    const blocked = await attempt();

    /**
     * `errorResponseBuilder` di @fastify/rate-limit costruisce un errore che il
     * plugin *lancia*: deve essere un `Error` annotato con `statusCode`, non
     * l'involucro `{ error: ... }` della risposta. Restituendo un oggetto
     * qualunque l'error handler non lo riconosce e degrada tutto a 500,
     * trasformando un limite di sicurezza in un guasto apparente.
     */
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();

    const body = blocked.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('RATE_LIMITED');
    // Il messaggio finisce sotto il campo password della pagina di login, così
    // com'è: l'attesa che il plugin formatta in inglese («15 minutes») va
    // riscritta, altrimenti la frase esce mezza in una lingua e mezza in
    // un'altra.
    expect(body.error.message).toBe('Troppi tentativi. Riprova fra 15 minuti.');
  });
});
