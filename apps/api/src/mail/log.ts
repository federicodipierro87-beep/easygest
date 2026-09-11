import type { FastifyBaseLogger } from 'fastify';

import type { MailMessage, Mailer } from './types';

/**
 * Il trasporto di sviluppo: l'email finisce nei log.
 *
 * È il motivo per cui l'applicazione locale si avvia senza `RESEND_API_KEY`.
 * Scrive anche il corpo intero, non solo l'oggetto: provare un testo di
 * promemoria significa leggerlo, e un log che dice «inviata email a Federico»
 * non permette di accorgersi che dentro c'è una data sbagliata.
 */
export function createLogMailer(log: FastifyBaseLogger): Mailer {
  return {
    send(message: MailMessage): Promise<void> {
      log.info(
        { to: message.to, subject: message.subject, text: message.text },
        'Email (trasporto log: non inviata)',
      );
      return Promise.resolve();
    },
  };
}
