import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { type Env, resolveMailTransport } from '../config/env';
import { createLogMailer } from './log';
import { createMemoryMailer } from './memory';
import { createResendMailer } from './resend';
import type { Mailer } from './types';

// Riesportata da dove è sempre stata importata: la funzione si è spostata nella
// configurazione, ma è del mailer che si parla, e chi la cerca la cerca qui.
export { resolveMailTransport } from '../config/env';
export { MailDeliveryError, createResendMailer } from './resend';
export { createMemoryMailer, type MemoryMailer } from './memory';
export { escapeHtml, renderHtml } from './render';
export type { MailMessage, MailTransport, Mailer } from './types';

declare module 'fastify' {
  interface FastifyInstance {
    mailer: Mailer;
  }
}

export function createMailer(env: Env, log: FastifyBaseLogger): Mailer {
  const transport = resolveMailTransport(env);

  switch (transport) {
    case 'resend':
      // Non ricontrolla la chiave: il `superRefine` di `env.ts` ha già
      // impedito al processo di arrivare fin qui senza. Un secondo controllo
      // qui sarebbe un secondo posto in cui sbagliare il messaggio d'errore.
      //
      // L'invariante regge perché la validazione usa `resolveMailTransport`, la
      // stessa funzione chiamata qui sopra. Quando invece guardava la variabile
      // grezza, questa riga produceva un mailer con `apiKey: ''` ogni volta che
      // il trasporto era dedotto da `NODE_ENV` — ed è la ragione per cui la
      // funzione è stata spostata in `config/env.ts`.
      return createResendMailer({ apiKey: env.RESEND_API_KEY ?? '', from: env.MAIL_FROM });
    case 'memory':
      return createMemoryMailer();
    case 'log':
      return createLogMailer(log);
  }
}

/**
 * Il mailer sta dentro `buildApp`, a differenza dello scheduler.
 *
 * Sono due decisioni opposte e deliberate: lo scheduler in `buildApp` sarebbe
 * una condizione di corsa contro i test di integrazione, mentre il mailer ci
 * deve stare, perché serve anche alla rotta di esecuzione manuale e nei test
 * dev'essere sostituibile — con `NODE_ENV=test` diventa da solo quello in
 * memoria, senza che nessun test debba ricordarsene.
 */
export const mailerPlugin = fp(
  function mailerPlugin(app: FastifyInstance, env: Env): Promise<void> {
    const transport = resolveMailTransport(env);
    app.decorate('mailer', createMailer(env, app.log));
    app.log.info({ transport, from: env.MAIL_FROM }, 'Posta configurata');
    return Promise.resolve();
  },
  { name: 'mailer' },
);
