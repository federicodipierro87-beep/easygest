/**
 * I lavori pianificati, visti da fuori.
 *
 * Qui c'è solo ciò che attraversa la rete: i nomi che `POST /jobs/:name/run`
 * accetta e i contatori che restituisce. Il contesto di esecuzione — Prisma, il
 * mailer, l'orologio — resta in `apps/api/src/jobs/types.ts`, dove serve.
 *
 * Sta in `shared` per la stessa ragione di `Settings` e `Notification`: è la
 * forma di una risposta che il frontend legge, e duplicarla nel `web`
 * significherebbe scoprire da un valore `undefined` a schermo, invece che da un
 * errore di compilazione, il giorno in cui si aggiunge un contatore.
 */

export const JOB_NAMES = ['daily', 'fx'] as const;
export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

/**
 * Cosa ha fatto un giro.
 *
 * È esattamente ciò che si vuole leggere dopo aver premuto «Esegui adesso» in
 * produzione: non «ok», ma quante email sono partite e quante scadenze sono
 * state marcate pagate. Un contatore a zero dove ce se ne aspettava uno è
 * un'informazione; un `200 OK` no.
 */
export interface JobCounters {
  fxRates: number;
  occurrencesSynced: number;
  markedPaid: number;
  remindersPlanned: number;
  emailsSent: number;
  notificationsCreated: number;
  /**
   * Quante cose sono andate storte senza fermare il giro.
   *
   * Un fallimento qui non è un'eccezione: una spesa in corone senza tasso non
   * deve impedire alle altre ventisei di essere sincronizzate. Il numero serve
   * a non far passare per riuscito un giro che è riuscito a metà.
   */
  failures: number;
}

export function emptyCounters(): JobCounters {
  return {
    fxRates: 0,
    occurrencesSynced: 0,
    markedPaid: 0,
    remindersPlanned: 0,
    emailsSent: 0,
    notificationsCreated: 0,
    failures: 0,
  };
}

export interface JobResult {
  name: JobName;
  durationMs: number;
  counters: JobCounters;
}

/**
 * I contatori in italiano, nell'ordine in cui il giro li produce.
 *
 * L'ordine è quello della pipeline — cambi, scadenze materializzate, marcate
 * pagate, avvisi, email, notifiche, guasti — così l'elenco a schermo si legge
 * come il racconto di ciò che è successo invece che come un dizionario.
 */
export const JOB_COUNTER_LABELS: Record<keyof JobCounters, string> = {
  fxRates: 'Cambi scaricati',
  occurrencesSynced: 'Scadenze generate',
  markedPaid: 'Marcate pagate',
  remindersPlanned: 'Avvisi previsti',
  emailsSent: 'Email inviate',
  notificationsCreated: 'Notifiche create',
  failures: 'Errori non bloccanti',
};
