import { z } from 'zod';

import { renderHtml } from './render';
import type { MailMessage, Mailer } from './types';

/**
 * Resend, senza SDK.
 *
 * È una `POST` con tre campi e una chiave nell'header: il pacchetto `resend`
 * aggiungerebbe una dipendenza, i suoi aggiornamenti e la sua idea di come
 * gestire gli errori, per risparmiare quindici righe. La stessa scelta è già
 * stata fatta in `services/frankfurter.ts`, che è l'unico altro servizio
 * esterno del progetto, e vale la pena che i due si somiglino.
 */

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Iniettato nei test: nessuna rete durante la suite. */
export type ResendFetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Della risposta serve solo l'identificativo, ma va letto con uno schema.
 *
 * Un 200 con un corpo inatteso è il caso che si vuole vedere subito: senza
 * questo controllo, un cambio di forma dell'API si manifesterebbe come email
 * che risultano inviate e non arrivano.
 */
const resendResponseSchema = z.object({ id: z.string() });

export class MailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

export interface ResendMailerOptions {
  apiKey: string;
  from: string;
  fetcher?: ResendFetcher;
}

export function createResendMailer(options: ResendMailerOptions): Mailer {
  const fetcher: ResendFetcher = options.fetcher ?? ((url, init) => fetch(url, init));

  return {
    async send(message: MailMessage): Promise<void> {
      const response = await fetcher(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html ?? renderHtml(message.text),
        }),
      });

      if (!response.ok) {
        // Il corpo serve, non basta lo stato: un 422 da solo non distingue «il
        // mittente non è verificato» da «il destinatario non è il titolare
        // dell'account», che sono i due modi in cui questa integrazione
        // fallisce davvero la prima volta. Duecento caratteri bastano al
        // messaggio di Resend e tengono i log leggibili.
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new MailDeliveryError(
          `Resend ha risposto ${String(response.status)}: ${detail || '(corpo vuoto)'}`,
        );
      }

      const parsed = resendResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new MailDeliveryError('Risposta di Resend non riconosciuta');
      }
    },
  };
}
