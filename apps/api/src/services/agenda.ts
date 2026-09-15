import {
  type DigestLine,
  type DigestSections,
  addDays,
  cancellationDeadline,
} from '@easygest/shared';

import type { AppPrismaClient } from '../db/client';
import type { Prisma } from '../generated/prisma/client';

/**
 * Le quattro domande del giorno: cosa arriva, cosa va confermato, cosa è in
 * ritardo, cosa va disdetto prima che si rinnovi.
 *
 * Vive qui e non dentro `jobs/digest.ts` perché ha due consumatori con esigenze
 * diverse ma **una sola definizione di verità**: il riepilogo settimanale via
 * email e la dashboard via HTTP. Con due implementazioni ci sarebbero due idee
 * di cosa sia «in ritardo», e divergerebbero al primo ritocco — nel modo
 * peggiore, cioè senza che nessuno se ne accorga finché un utente non confronta
 * il numero sulla pagina con quello nell'oggetto dell'email.
 *
 * Tre differenze rispetto al `collectSections` da cui è estratto, tutte dovute
 * al secondo consumatore:
 *
 * 1. Prende un `AppPrismaClient` e non un `JobContext`: una rotta HTTP non ha
 *    un contesto di lavoro pianificato, e fabbricarne uno finto per poter fare
 *    una query sarebbe un tipo costruito per essere ignorato.
 * 2. `AgendaRow` porta `occurrenceId` e `baseGrossCents`. Il primo serve a
 *    poter fare `PATCH /occurrences/:id` direttamente dalla dashboard; il
 *    secondo perché i totali si fanno in valuta base. `DigestLine` non ha né
 *    l'uno né l'altro, e non deve averli: a un'email di testo non servono.
 * 3. `total` e `totalCents` arrivano da un `aggregate`, non da `rows.length`.
 *    Con `take: 5` la dashboard direbbe «5 da confermare» quando sono
 *    trentaquattro, ed è precisamente il bug che questa estrazione esiste per
 *    prevenire.
 */

/** Quanto avanti guarda la sezione delle scadenze. */
export const UPCOMING_DAYS = 7;

/**
 * Quanto avanti guarda la sezione delle disdette.
 *
 * Trenta giorni e non sette: una finestra di disdetta si chiude una volta sola
 * e disdire richiede tempo — una raccomandata, un modulo, una telefonata — per
 * cui vederla arrivare da lontano è il punto. Le scadenze no: sono ricorrenti,
 * e quella del mese prossimo tornerà nell'agenda della settimana giusta.
 */
export const CANCELLATION_DAYS = 30;

/** Quante righe per sezione, quando chi chiama non lo dice. */
const DEFAULT_TAKE = 20;

export interface AgendaRow {
  occurrenceId: string;
  expenseId: string;
  expenseName: string;
  dueDate: Date;
  grossCents: number;
  currency: string;
  baseGrossCents: number;
  /** Solo nelle disdette: ultimo giorno utile per disdire prima del rinnovo. */
  deadline?: Date;
}

export interface AgendaSection {
  /** Le prime `take` righe, non tutte. */
  rows: AgendaRow[];
  /** Quante sono davvero, oltre quelle mostrate. */
  total: number;
  /** Somma reale di `baseGrossCents`, non quella delle righe mostrate. */
  totalCents: number;
}

export interface Agenda {
  today: Date;
  upcoming: AgendaSection;
  toConfirm: AgendaSection;
  overdue: AgendaSection;
  cancellations: AgendaSection;
}

const ROW_SELECT = {
  id: true,
  expenseId: true,
  dueDate: true,
  grossCents: true,
  currency: true,
  baseGrossCents: true,
  expense: { select: { name: true } },
} satisfies Prisma.ExpenseOccurrenceSelect;

type RowPayload = Prisma.ExpenseOccurrenceGetPayload<{ select: typeof ROW_SELECT }>;

function toAgendaRow(row: RowPayload): AgendaRow {
  return {
    occurrenceId: row.id,
    expenseId: row.expenseId,
    expenseName: row.expense.name,
    dueDate: row.dueDate,
    grossCents: row.grossCents,
    currency: row.currency,
    baseGrossCents: row.baseGrossCents,
  };
}

/**
 * Una sezione: le prime righe, più i due numeri che le riassumono tutte.
 *
 * L'ordinamento ha `id` come secondo criterio perché con un `take` la
 * precedenza fra due scadenze dello stesso giorno smette di essere un dettaglio
 * estetico: senza, due chiamate identiche possono mostrare righe diverse.
 */
async function section(
  prisma: AppPrismaClient,
  where: Prisma.ExpenseOccurrenceWhereInput,
  take: number,
): Promise<AgendaSection> {
  const [rows, totals] = await Promise.all([
    prisma.expenseOccurrence.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take,
      select: ROW_SELECT,
    }),
    prisma.expenseOccurrence.aggregate({ where, _count: true, _sum: { baseGrossCents: true } }),
  ]);

  return {
    rows: rows.map(toAgendaRow),
    total: totals._count,
    // `_sum` è `null` su un insieme vuoto, che non è zero per Postgres ma lo è
    // per chiunque legga un totale.
    totalCents: totals._sum.baseGrossCents ?? 0,
  };
}

/**
 * Le disdette, e perché sono l'unica sezione che non passa da `section`.
 *
 * La deduplica per spesa avviene in JavaScript — di una spesa mensile
 * interessa solo il primo rinnovo, non i dodici dell'anno — e il filtro sul
 * termine di disdetta dipende da `cancellationNoticeDays`, che sta sulla spesa
 * e non sull'occorrenza. Nessuna delle due cose è esprimibile come `count`,
 * quindi `total` e `totalCents` si calcolano sull'elenco già ridotto. È
 * l'eccezione, ed è il motivo per cui la query non porta un `take`: tagliare
 * prima di deduplicare toglierebbe righe che sarebbero sopravvissute.
 */
async function collectCancellations(
  prisma: AppPrismaClient,
  userId: string,
  today: Date,
  take: number,
): Promise<AgendaSection> {
  const candidates = await prisma.expenseOccurrence.findMany({
    where: {
      userId,
      status: 'PLANNED',
      dueDate: { gte: today },
      expense: {
        status: 'ACTIVE',
        autoRenew: true,
        cancelledAt: null,
        cancellationNoticeDays: { not: null },
      },
    },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    select: { ...ROW_SELECT, expense: { select: { name: true, cancellationNoticeDays: true } } },
  });

  const seen = new Set<string>();
  const all: AgendaRow[] = [];

  for (const row of candidates) {
    if (seen.has(row.expenseId)) continue;
    seen.add(row.expenseId);

    const notice = row.expense.cancellationNoticeDays;
    if (notice === null) continue;
    const deadline = cancellationDeadline(row.dueDate, notice);
    if (deadline === null) continue;
    if (deadline < today || deadline > addDays(today, CANCELLATION_DAYS)) continue;

    all.push({ ...toAgendaRow(row), deadline });
  }

  return {
    rows: all.slice(0, take),
    total: all.length,
    totalCents: all.reduce((sum, row) => sum + row.baseGrossCents, 0),
  };
}

/**
 * L'agenda di un utente per un dato giorno.
 *
 * `today` è un parametro e non `new Date()`: il giorno di calendario dipende
 * dal fuso dell'utente, che chi chiama conosce e questo modulo no.
 */
export async function collectAgenda(
  prisma: AppPrismaClient,
  userId: string,
  today: Date,
  options: { take?: number } = {},
): Promise<Agenda> {
  const take = options.take ?? DEFAULT_TAKE;

  const [upcoming, toConfirm, overdue, cancellations] = await Promise.all([
    section(
      prisma,
      {
        userId,
        status: 'PLANNED',
        dueDate: { gte: today, lte: addDays(today, UPCOMING_DAYS) },
      },
      take,
    ),
    section(prisma, { userId, status: 'PAID', confirmedAt: null }, take),
    section(prisma, { userId, status: 'PLANNED', dueDate: { lt: today } }, take),
    collectCancellations(prisma, userId, today, take),
  ]);

  return { today, upcoming, toConfirm, overdue, cancellations };
}

/**
 * L'agenda ridotta a quello che un'email di testo sa dire.
 *
 * Perde `occurrenceId`, `baseGrossCents` e i totali, che in un messaggio senza
 * collegamenti e senza colonne non avrebbero dove andare. Nelle disdette la
 * data diventa il **termine** e il rinnovo passa in `renewsOn`: è quella la
 * scadenza che conta, mentre il giorno del rinnovo è solo quando parte
 * l'addebito.
 */
export function toDigestSections(agenda: Agenda): DigestSections {
  const line = (row: AgendaRow): DigestLine => ({
    label: row.expenseName,
    date: row.dueDate,
    grossCents: row.grossCents,
    currency: row.currency,
  });

  return {
    upcoming: agenda.upcoming.rows.map(line),
    cancellations: agenda.cancellations.rows.map((row) => ({
      label: row.expenseName,
      date: row.deadline ?? row.dueDate,
      grossCents: row.grossCents,
      currency: row.currency,
      renewsOn: row.dueDate,
    })),
    toConfirm: agenda.toConfirm.rows.map(line),
    overdue: agenda.overdue.rows.map(line),
  };
}
