/**
 * Il confine fra «ho deciso cosa dire» e «lo mando».
 *
 * Un'interfaccia con un metodo solo sembra cerimonia inutile finché non si
 * guarda cosa compra: la pipeline degli avvisi si prova senza rete, senza
 * chiavi e senza aspettare, perché nei test il mailer è un oggetto che
 * accumula messaggi in un array. Senza questo confine, provare il giro
 * notturno vorrebbe dire o mandare email vere o riempire il codice di `if
 * (isTest)`.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /**
   * Il corpo in testo semplice.
   *
   * Non è un ripiego per i client che non fanno HTML — è la parte che si legge
   * dall'anteprima del telefono, ed è la stessa stringa che finisce in
   * `Notification.body`. Per questo è obbligatoria e l'HTML no.
   */
  text: string;
  /** Se assente, `render.ts` lo ricava dal testo. */
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Il nome del trasporto, per dirlo nei log all'avvio. */
export type MailTransport = 'resend' | 'log' | 'memory';
