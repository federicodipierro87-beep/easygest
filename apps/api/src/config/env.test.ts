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

describe('lavori pianificati', () => {
  it('tiene spento il cron finché non lo si accende esplicitamente', () => {
    // A differenza del resto della configurazione, il giro notturno *scrive*:
    // marca PAID le scadenze arretrate e manda email. Acceso per distrazione
    // su una copia del database di produzione farebbe danni silenziosi.
    expect(parseEnv(required).CRON_ENABLED).toBe(false);
    expect(parseEnv({ ...required, CRON_ENABLED: 'true' }).CRON_ENABLED).toBe(true);
  });

  it('rifiuta un valore ambiguo per CRON_ENABLED', () => {
    expect(() => parseEnv({ ...required, CRON_ENABLED: 'si' })).toThrow(EnvValidationError);
  });

  it('usa l’ora italiana e rifiuta un fuso inventato', () => {
    expect(parseEnv(required).CRON_TIMEZONE).toBe('Europe/Rome');
    expect(parseEnv({ ...required, CRON_TIMEZONE: 'UTC' }).CRON_TIMEZONE).toBe('UTC');
    expect(() => parseEnv({ ...required, CRON_TIMEZONE: 'Europe/Atlantide' })).toThrow(
      /CRON_TIMEZONE/,
    );
  });

  it('aspetta venti secondi prima del giro di recupero', () => {
    expect(parseEnv(required).CRON_CATCHUP_DELAY_MS).toBe(20_000);
    expect(parseEnv({ ...required, CRON_CATCHUP_DELAY_MS: '0' }).CRON_CATCHUP_DELAY_MS).toBe(0);
  });

  it('pota le notifiche lette dopo sei mesi', () => {
    expect(parseEnv(required).NOTIFICATION_RETENTION_DAYS).toBe(180);
  });
});

describe('posta', () => {
  it('lascia scegliere il trasporto a createMailer quando nessuno lo impone', () => {
    // Il default dipende da NODE_ENV e vive in `createMailer`: scriverlo anche
    // qui significherebbe avere due copie della stessa regola, e la seconda
    // finirebbe per divergere.
    expect(parseEnv(required).MAIL_TRANSPORT).toBeUndefined();
  });

  it('rifiuta un trasporto che non esiste', () => {
    expect(() => parseEnv({ ...required, MAIL_TRANSPORT: 'smtp' })).toThrow(/MAIL_TRANSPORT/);
  });

  it('non parte con Resend senza chiave', () => {
    // Fallire all'avvio è il punto: altrimenti l'applicazione lavora tutto il
    // giorno e scopre di non poter mandare niente alle sette del mattino.
    expect(() => parseEnv({ ...required, MAIL_TRANSPORT: 'resend' })).toThrow(/RESEND_API_KEY/);
    expect(
      parseEnv({ ...required, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test' }).RESEND_API_KEY,
    ).toBe('re_test');
  });

  it('parte senza chiave con gli altri trasporti', () => {
    // In sviluppo si lavora sull'applicazione, non sulle email: pretendere una
    // chiave di Resend per avviare il server locale sarebbe un pedaggio inutile.
    expect(parseEnv({ ...required, MAIL_TRANSPORT: 'log' }).RESEND_API_KEY).toBeUndefined();
  });

  it('ha un mittente e una radice per i link', () => {
    const env = parseEnv(required);
    expect(env.MAIL_FROM).toContain('@');
    expect(env.APP_BASE_URL).toBe('http://localhost:5173');
  });

  it('pretende che APP_BASE_URL sia un URL', () => {
    // Finisce concatenato ai percorsi dentro le email: un valore come
    // "easygest.it" produrrebbe link rotti in tutti i messaggi inviati.
    expect(() => parseEnv({ ...required, APP_BASE_URL: 'easygest.it' })).toThrow(/APP_BASE_URL/);
  });
});
