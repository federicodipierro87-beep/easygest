import type { FastifyBaseLogger } from 'fastify';

import type { AppPrismaClient } from '../db/client';
import type { Mailer } from '../mail';

/**
 * Le forme comuni ai lavori pianificati.
 *
 * Tutto ciò che un lavoro tocca — database, posta, orologio — entra come
 * parametro. Non è purismo: è ciò che permette a `daily.test.ts` di eseguire il
 * giro vero, due volte di fila, con un mailer in memoria e un `now` scritto a
 * mano, senza rete e senza `vi.useFakeTimers()`.
 */

export const JOB_NAMES = ['daily', 'fx'] as const;
export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

export interface JobContext {
  prisma: AppPrismaClient;
  mailer: Mailer;
  log: FastifyBaseLogger;
  /**
   * L'istante di riferimento.
   *
   * Parametro e non `new Date()` sparso nel codice, per la stessa ragione già
   * scritta nel commento di `occurrenceContext`: un test che dipende
   * dall'orologio si scrive una volta e poi fallisce da solo il primo giorno
   * in cui il fuso cambia.
   */
  now: Date;
  /** Radice dei link nelle email. */
  baseUrl: string;
  /** Dopo quanti giorni si cancellano le notifiche già lette. */
  notificationRetentionDays: number;
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
