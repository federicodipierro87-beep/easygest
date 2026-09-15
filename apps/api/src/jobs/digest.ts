import {
  composeDigest,
  digestKey,
  isDigestEmpty,
  isoWeekday,
  startOfUtcDay,
} from '@easygest/shared';

import { Prisma } from '../generated/prisma/client';
import { collectAgenda, toDigestSections } from '../services/agenda';
import type { JobContext } from './types';

/**
 * Il riepilogo settimanale.
 *
 * Vive dentro il giro giornaliero e non ha una pianificazione propria: il
 * giorno in cui mandarlo è una preferenza dell'utente, letta dalle sue
 * impostazioni e valutata nel suo fuso. Un cron separato dovrebbe svegliarsi
 * tutti i giorni per rileggere le stesse righe e decidere la stessa cosa —
 * cioè fare esattamente questo, con una pianificazione in più da mantenere.
 *
 * Le quattro sezioni non si calcolano qui: le calcola `services/agenda.ts`, che
 * è lo stesso codice da cui legge la dashboard. Il numero «da confermare» nella
 * riga dell'oggetto e quello sul riquadro della pagina vengono quindi dalla
 * stessa query, e non possono divergere.
 */

/** Oggi è il giorno scelto dall'utente per il riepilogo? */
export function isDigestDay(today: Date, digestDayOfWeek: number): boolean {
  return isoWeekday(today) === digestDayOfWeek;
}

export interface DigestResult {
  sent: number;
  failures: number;
}

/**
 * Manda il riepilogo, se è il giorno e se c'è qualcosa da dire.
 *
 * La riga di deduplica si scrive **anche quando non si manda niente**: senza,
 * ogni riavvio dello stesso giorno rifarebbe le quattro query per riscoprire
 * che non c'è nulla. La chiave usa la settimana ISO e non la data — con la
 * data, spostare `digestDayOfWeek` da lunedì a mercoledì manderebbe due
 * riepiloghi nella stessa settimana.
 *
 * L'ordine è lo stesso delle email dei promemoria, e per le stesse ragioni:
 * prenota, invia, annota.
 */
export async function runDigest(
  context: JobContext,
  user: { id: string; email: string },
  today: Date,
  settings: { digestEnabled: boolean; digestDayOfWeek: number },
): Promise<DigestResult> {
  const day = startOfUtcDay(today);
  if (!settings.digestEnabled || !isDigestDay(day, settings.digestDayOfWeek)) {
    return { sent: 0, failures: 0 };
  }

  const { prisma, mailer, log, baseUrl } = context;
  const dedupeKey = digestKey(user.id, day);

  try {
    await prisma.reminderLog.create({
      data: {
        userId: user.id,
        kind: 'DIGEST',
        channel: 'EMAIL',
        dedupeKey,
        referenceDate: day,
        succeeded: false,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { sent: 0, failures: 0 };
    }
    throw error;
  }

  const sections = toDigestSections(await collectAgenda(prisma, user.id, day, { take: 20 }));

  if (isDigestEmpty(sections)) {
    // Un'email che dice «non c'è niente» una volta a settimana è il modo più
    // efficace di far spegnere le notifiche. La riga resta, con `succeeded`
    // a false: non è un fallimento, è un invio che non è avvenuto, e la
    // distinzione la fa `errorMessage`.
    await prisma.reminderLog.updateMany({
      where: { dedupeKey },
      data: { errorMessage: 'riepilogo vuoto, non inviato' },
    });
    return { sent: 0, failures: 0 };
  }

  const message = composeDigest(sections, { baseUrl });

  try {
    await mailer.send({ to: user.email, subject: message.subject, text: message.text });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'errore sconosciuto';
    await prisma.reminderLog.updateMany({
      where: { dedupeKey },
      data: { errorMessage: reason.slice(0, 500) },
    });
    log.error({ err: error }, 'Riepilogo non inviato');
    return { sent: 0, failures: 1 };
  }

  await prisma.reminderLog.updateMany({ where: { dedupeKey }, data: { succeeded: true } });
  return { sent: 1, failures: 0 };
}
