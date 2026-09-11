import type { FastifyBaseLogger } from 'fastify';

import type { AppPrismaClient } from '../db/client';
import type { Mailer } from '../mail';
import type { Fetcher } from '../services/frankfurter';

/**
 * Il contesto di esecuzione dei lavori pianificati.
 *
 * Tutto ciò che un lavoro tocca — database, posta, orologio — entra come
 * parametro. Non è purismo: è ciò che permette a `daily.test.ts` di eseguire il
 * giro vero, due volte di fila, con un mailer in memoria e un `now` scritto a
 * mano, senza rete e senza `vi.useFakeTimers()`.
 *
 * I nomi dei lavori e i contatori stanno invece in `@easygest/shared`: sono la
 * forma di una risposta HTTP, e il frontend li legge.
 */

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
  /**
   * Da dove arrivano i tassi.
   *
   * Opzionale, e nei test è l'unica ragione per cui esiste: il giro giornaliero
   * comincia chiamando la BCE, e una suite che esce in rete fallisce in aereo,
   * in CI dietro un proxy e il giorno in cui Frankfurter è giù — cioè fallisce
   * per ragioni che non hanno niente a che vedere con ciò che sta provando.
   */
  fetcher?: Fetcher;
}
