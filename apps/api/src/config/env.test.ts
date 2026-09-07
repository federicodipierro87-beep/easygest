import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from './env';

describe('parseEnv', () => {
  it('applica i default in sviluppo senza alcuna variabile impostata', () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('converte la porta da stringa a intero', () => {
    expect(parseEnv({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('divide le origini CORS e ignora spazi e voci vuote', () => {
    const env = parseEnv({
      CORS_ORIGINS: 'https://easygest.netlify.app , https://easygest.it ,',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://easygest.netlify.app', 'https://easygest.it']);
  });

  it('rifiuta una origine CORS che non è un URL', () => {
    // Un valore come "*" o "easygest.it" passerebbe silenziosamente a Fastify
    // e produrrebbe una policy CORS diversa da quella che credi di avere.
    expect(() => parseEnv({ CORS_ORIGINS: 'easygest.it' })).toThrow(EnvValidationError);
  });

  it('rifiuta una porta fuori intervallo e spiega quale variabile è sbagliata', () => {
    expect(() => parseEnv({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
