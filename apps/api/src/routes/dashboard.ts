import {
  type AgendaLine,
  type AgendaSectionSummary,
  type DashboardSummary,
  addMonths,
  divideRoundHalfUp,
  formatIsoDate,
  todayIn,
  utcDay,
} from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { Prisma } from '../generated/prisma/client';
import { requireUser } from '../plugins/auth';
import type { AgendaRow, AgendaSection } from '../services/agenda';
import { collectAgenda } from '../services/agenda';

/**
 * L'agenda del giorno, per la pagina invece che per l'email.
 *
 * Le quattro sezioni arrivano da `services/agenda.ts`, che è lo stesso codice
 * da cui legge il riepilogo settimanale. Non è un risparmio di righe: è quello
 * che rende impossibile che il numero «da confermare» sul riquadro e quello
 * nell'oggetto dell'email dicano due cose diverse. Il giorno in cui
 * divergessero, nessuno dei due sarebbe più credibile.
 *
 * Nessun parametro di query, e quindi nessuno schema: la dashboard è «oggi».
 */

/** Quante righe entrano in un riquadro. Le altre restano nel conteggio. */
const TAKE = 5;

/**
 * Gli stati che non sono costati nulla.
 *
 * `SKIPPED` è una scadenza saltata, `CANCELLED` una annullata: contarle
 * gonfierebbe il costo del mese con soldi mai usciti. `PLANNED` invece resta,
 * perché il mese in corso è fatto in gran parte di scadenze non ancora pagate
 * e un numero che le ignora crescerebbe da solo fino al 31.
 */
const SPENT = {
  notIn: ['SKIPPED', 'CANCELLED'],
} satisfies Prisma.EnumOccurrenceStatusFilter<'ExpenseOccurrence'>;

function toLine(row: AgendaRow): AgendaLine {
  return {
    occurrenceId: row.occurrenceId,
    expenseId: row.expenseId,
    expenseName: row.expenseName,
    dueDate: formatIsoDate(row.dueDate),
    grossCents: row.grossCents,
    currency: row.currency,
    baseGrossCents: row.baseGrossCents,
    ...(row.deadline === undefined ? {} : { deadline: formatIsoDate(row.deadline) }),
  };
}

function toSection(section: AgendaSection): AgendaSectionSummary {
  return {
    lines: section.rows.map(toLine),
    total: section.total,
    totalCents: section.totalCents,
  };
}

/** Il primo giorno del mese a cui un giorno appartiene. */
function startOfMonth(day: Date): Date {
  return utcDay(day.getUTCFullYear(), day.getUTCMonth() + 1, 1);
}

export function registerDashboardRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: app.authenticate };

  app.get('/dashboard', guarded, async (request) => {
    const user = requireUser(request);

    /**
     * `upsert` e non `findUnique`, per la stessa ragione di `routes/settings.ts`:
     * la riga la crea il seed, ma un utente arrivato per altra via si
     * troverebbe un 500 sulla prima pagina che apre. I default sono quelli
     * dello schema, non una seconda copia scritta qui.
     */
    const settings = await app.prisma.settings.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
      select: { timezone: true, baseCurrency: true },
    });

    /**
     * «Oggi» è il giorno dell'utente, non quello del server.
     *
     * È la stessa funzione che usa il cron, e con lo stesso argomento: a
     * mezzanotte e mezza a Roma in UTC è ancora ieri, e una scadenza dovuta
     * oggi risulterebbe futura per mezz'ora ogni notte — per un'ora e mezza
     * d'estate. Il riquadro «in ritardo» si svuoterebbe e si riempirebbe da
     * solo, e solo a quell'ora.
     */
    const today = todayIn(settings.timezone, new Date());

    const monthStart = startOfMonth(today);
    const nextMonthStart = addMonths(monthStart, 1);
    // I dodici mesi conclusi finiscono dove comincia quello in corso.
    const twelveMonthsAgo = addMonths(monthStart, -12);

    const [agenda, currentMonth, twelveMonths] = await Promise.all([
      collectAgenda(app.prisma, user.id, today, { take: TAKE }),
      app.prisma.expenseOccurrence.aggregate({
        where: {
          userId: user.id,
          status: SPENT,
          dueDate: { gte: monthStart, lt: nextMonthStart },
        },
        _sum: { baseGrossCents: true },
      }),
      app.prisma.expenseOccurrence.aggregate({
        where: {
          userId: user.id,
          status: SPENT,
          dueDate: { gte: twelveMonthsAgo, lt: monthStart },
        },
        _sum: { baseGrossCents: true },
      }),
    ]);

    // `_sum` è `null` su un insieme vuoto: per Postgres non è zero, per chi
    // legge un totale sì — e un `null` che arriva in pagina si stampa «NaN €».
    const twelveMonthsCents = twelveMonths._sum?.baseGrossCents ?? 0;

    const summary: DashboardSummary = {
      today: formatIsoDate(today),
      baseCurrency: settings.baseCurrency,
      upcoming: toSection(agenda.upcoming),
      toConfirm: toSection(agenda.toConfirm),
      overdue: toSection(agenda.overdue),
      cancellations: toSection(agenda.cancellations),
      currentMonthCents: currentMonth._sum?.baseGrossCents ?? 0,
      // Mai una divisione in virgola mobile su del denaro: dodicesimi di
      // centesimo che si accumulano sono il modo classico di far sballare un
      // totale di qualche euro senza che nessuna riga sia sbagliata.
      monthlyAverageCents: divideRoundHalfUp(twelveMonthsCents, 12),
    };

    return summary;
  });
}
