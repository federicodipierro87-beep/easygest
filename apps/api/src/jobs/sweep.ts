import { startOfUtcDay } from '@easygest/shared';

import { type OccurrenceContext, syncOccurrences } from '../services/occurrences';
import type { JobContext } from './types';

/**
 * Le due manutenzioni che vanno fatte *prima* di guardare le scadenze.
 *
 * Chiude il debito dichiarato in `PROGRESS.md`: finora le occorrenze si
 * materializzavano solo quando qualcuno toccava la spesa, quindi fra tredici
 * mesi le scadenze semplicemente finivano e nessuno le rigenerava.
 *
 * L'ordine dentro il giro giornaliero è vincolato — cambi, poi questo, poi i
 * promemoria — e la ragione è tutta nel passo 1: è lo sweep a materializzare le
 * occorrenze su cui i promemoria scattano. Invertendoli, il giorno in cui
 * l'orizzonte si estende la scadenza appena nata non riceverebbe il suo avviso
 * a trenta giorni, perché al momento del controllo non esisteva ancora.
 */

export interface SweepResult {
  occurrencesSynced: number;
  markedPaid: number;
  failures: number;
  /** Le occorrenze appena marcate pagate, per la notifica raggruppata. */
  paidIds: string[];
}

/**
 * Estende l'orizzonte di tutte le spese attive dell'utente.
 *
 * Il `try/catch` è **per singola spesa** e non intorno al ciclo: una spesa in
 * corone senza tasso del giorno fa fallire `convertToBase` con un 422, e se
 * quell'errore risalisse fermerebbe la sincronizzazione delle altre ventisei —
 * cioè un problema di una spesa diventerebbe un problema di tutte, e nel modo
 * più difficile da diagnosticare: senza scadenze nuove e senza un errore
 * visibile da nessuna parte.
 */
async function extendHorizon(
  { prisma, log }: Pick<JobContext, 'prisma' | 'log'>,
  userId: string,
  context: OccurrenceContext,
): Promise<{ synced: number; failures: number }> {
  const expenses = await prisma.expense.findMany({ where: { userId, status: 'ACTIVE' } });

  let synced = 0;
  let failures = 0;

  for (const expense of expenses) {
    try {
      const result = await syncOccurrences(prisma, expense, context);
      synced += result.created;
    } catch (error) {
      failures += 1;
      log.warn(
        { err: error, expenseId: expense.id, expense: expense.name },
        'Orizzonte non esteso per questa spesa',
      );
    }
  }

  return { synced, failures };
}

/**
 * Marca pagate le scadute che si pagano da sole.
 *
 * Due decisioni dentro tre righe di codice.
 *
 * `paidAt = dueDate` e non «adesso»: l'addebito è avvenuto il giorno della
 * scadenza, non il giorno in cui il cron se n'è accorto. Scrivere `now`
 * significherebbe che un giro saltato per due giorni sposta i pagamenti di due
 * giorni, e i conti del mese finirebbero nel mese sbagliato. È anche il motivo
 * per cui è un ciclo di `update` e non un `updateMany`: quest'ultimo non sa
 * copiare il valore di una colonna in un'altra.
 *
 * `confirmedAt` non si tocca **mai**. È il meccanismo con cui ci si accorge
 * degli aumenti di prezzo: `PAID` dice «il denaro è uscito», `confirmedAt` dice
 * «l'ho guardato e l'importo era quello giusto». Se il cron confermasse da sé,
 * un abbonamento che passa da 12 a 19 euro non lo direbbe a nessuno.
 */
async function markAutoPaid(
  { prisma }: Pick<JobContext, 'prisma'>,
  userId: string,
  today: Date,
): Promise<string[]> {
  const overdue = await prisma.expenseOccurrence.findMany({
    where: {
      userId,
      status: 'PLANNED',
      dueDate: { lt: today },
      expense: { autoRenew: true, status: 'ACTIVE' },
    },
    select: { id: true, dueDate: true },
  });

  for (const occurrence of overdue) {
    await prisma.expenseOccurrence.update({
      where: { id: occurrence.id },
      data: { status: 'PAID', paidAt: occurrence.dueDate },
    });
  }

  return overdue.map((occurrence) => occurrence.id);
}

export async function runSweep(
  context: JobContext,
  userId: string,
  occurrences: OccurrenceContext,
): Promise<SweepResult> {
  const today = startOfUtcDay(occurrences.today);

  const horizon = await extendHorizon(context, userId, occurrences);
  const paidIds = await markAutoPaid(context, userId, today);

  return {
    occurrencesSynced: horizon.synced,
    markedPaid: paidIds.length,
    failures: horizon.failures,
    paidIds,
  };
}
