import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from './env';

/**
 * Il minimo indispensabile perché la configurazione sia valida. I test che
 * verificano i default partono da qui e sovrascrivono solo ciò che li riguarda,
 * così aggiungere domani una variabile obbligatoria si corregge in un punto.
 */
const required = {
  DATABASE_URL: 'postgresql://easygest:easygest@localhost:55432/easygest',
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
};

describe('parseEnv', () => {
  it('applica i default in sviluppo con le sole variabili obbligatorie', () => {
    const env = parseEnv(required);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173']);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.ACCESS_TOKEN_TTL).toBe(900);
    expect(env.REFRESH_TOKEN_TTL).toBe(2_592_000);
  });

  it('tiene chiuse le registrazioni finché non le si apre esplicitamente', () => {
    // Il default deve essere la scelta prudente: un'applicazione a uso
    // personale con la registrazione aperta per distrazione raccoglie account
    // altrui senza che nessuno se ne accorga.
    expect(parseEnv(required).REGISTRATION_ENABLED).toBe(false);
    expect(parseEnv({ ...required, REGISTRATION_ENABLED: 'true' }).REGISTRATION_ENABLED).toBe(true);
  });

  it('rifiuta un valore ambiguo per REGISTRATION_ENABLED', () => {
    // `Boolean('false')` è `true`: una conversione ingenua aprirebbe le
    // registrazioni proprio scrivendo che si vogliono chiuse.
    expect(() => parseEnv({ ...required, REGISTRATION_ENABLED: 'no' })).toThrow(EnvValidationError);
  });

  it('non parte senza JWT_SECRET, né con una chiave troppo corta', () => {
    // Un default qui significherebbe firmare i token di produzione con una
    // chiave pubblicata su GitHub: chiunque potrebbe fabbricarsene uno valido.
    const { JWT_SECRET: _omitted, ...senzaChiave } = required;
    expect(() => parseEnv(senzaChiave)).toThrow(/JWT_SECRET/);
    expect(() => parseEnv({ ...required, JWT_SECRET: 'corta' })).toThrow(/JWT_SECRET/);
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
