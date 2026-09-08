import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from './env';

/**
 * Il minimo indispensabile perché la configurazione sia valida. I test che
 * verificano i default partono da qui e sovrascrivono solo ciò che li riguarda,
 * così aggiungere domani una variabile obbligatoria si corregge in un punto.
 */
const required = { DATABASE_URL: 'postgresql://easygest:easygest@localhost:55432/easygest' };

describe('parseEnv', () => {
  it('applica i default in sviluppo con le sole variabili obbligatorie', () => {
    const env = parseEnv(required);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173']);
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it('converte la porta da stringa a intero', () => {
    expect(parseEnv({ ...required, PORT: '8080' }).PORT).toBe(8080);
  });

  it('divide le origini CORS e ignora spazi e voci vuote', () => {
    const env = parseEnv({
      ...required,
      CORS_ORIGINS: 'https://easygest.netlify.app , https://easygest.it ,',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://easygest.netlify.app', 'https://easygest.it']);
  });

  it('rifiuta una origine CORS che non è un URL', () => {
    // Un valore come "*" o "easygest.it" passerebbe silenziosamente a Fastify
    // e produrrebbe una policy CORS diversa da quella che credi di avere.
    expect(() => parseEnv({ ...required, CORS_ORIGINS: 'easygest.it' })).toThrow(
      EnvValidationError,
    );
  });

  it('rifiuta una porta fuori intervallo e spiega quale variabile è sbagliata', () => {
    expect(() => parseEnv({ ...required, PORT: '70000' })).toThrow(/PORT/);
    expect(() => parseEnv({ ...required, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('non parte senza DATABASE_URL, invece di connettersi a un default', () => {
    // Un default qui sarebbe comodo e pericoloso: in produzione significherebbe
    // scrivere sul database sbagliato senza che nessuno se ne accorga.
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });
});
