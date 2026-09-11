import { MailDeliveryError } from './resend';
import type { MailMessage, Mailer } from './types';

/**
 * Il trasporto dei test: accumula invece di inviare.
 *
 * `sent` è quello che rende leggibile il test dell'idempotenza — due giri di
 * seguito, e dopo il secondo l'array ha ancora un elemento solo. `failNext`
 * serve all'altra metà: verificare che un invio fallito lasci la riga di
 * `ReminderLog` con `succeeded = false` e che il giro successivo **non**
 * riprovi, che è la scelta dichiarata e va protetta da una regressione.
 */
export interface MemoryMailer extends Mailer {
  readonly sent: MailMessage[];
  /** Fa fallire il prossimo invio, una volta sola. */
  failNext(message?: string): void;
}

export function createMemoryMailer(): MemoryMailer {
  const sent: MailMessage[] = [];
  let pendingFailure: string | null = null;

  return {
    sent,
    failNext(message = 'invio fallito di proposito') {
      pendingFailure = message;
    },
    send(message: MailMessage): Promise<void> {
      if (pendingFailure !== null) {
        const reason = pendingFailure;
        pendingFailure = null;
        // Lo stesso tipo che lancia il trasporto vero: se `deliver.ts` un
        // giorno distinguesse gli errori per tipo, il test continuerebbe a
        // esercitare il ramo giusto invece di uno inventato.
        return Promise.reject(new MailDeliveryError(reason));
      }
      sent.push(message);
      return Promise.resolve();
    },
  };
}
