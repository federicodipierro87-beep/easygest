/**
 * Quello che la dashboard chiede all'API: l'agenda di oggi, più due numeri che
 * le fanno da contesto.
 *
 * Non c'è uno schema di query perché `GET /dashboard` non ha parametri. La
 * dashboard è «oggi»: un selettore di periodo la trasformerebbe in un report a
 * metà, e i report hanno già una pagina loro. Zero opzioni significa zero
 * schema, zero validazione e zero modi di chiedere la cosa sbagliata.
 */

/**
 * Una riga d'agenda come arriva al browser.
 *
 * Le date sono stringhe `YYYY-MM-DD` e non istanti. La ragione è la stessa per
 * cui `formatDay` lavora per regex senza costruire un `Date`: un istante
 * serializzato porta con sé un orario, e il fuso del browser può spostarlo di
 * un giorno. Una scadenza del 1° marzo che a Roma si legge «28 febbraio» è un
 * errore che nessun test coglie e che si vede solo di notte.
 *
 * `occurrenceId` c'è perché dalla dashboard si deve poter confermare una
 * scadenza con `PATCH /occurrences/:id`: senza, il riquadro «da confermare»
 * sarebbe un elenco su cui non si può agire.
 */
export interface AgendaLine {
  occurrenceId: string;
  expenseId: string;
  expenseName: string;
  dueDate: string;
  grossCents: number;
  currency: string;
  baseGrossCents: number;
  /** Solo nelle disdette: ultimo giorno utile per disdire prima del rinnovo. */
  deadline?: string;
}

export interface AgendaSectionSummary {
  /** Le prime righe, non tutte: il riquadro ne mostra cinque. */
  lines: AgendaLine[];
  /**
   * Quante sono davvero.
   *
   * Non `lines.length`. Con cinque righe mostrate su trentaquattro, un
   * conteggio derivato dall'elenco direbbe «5 da confermare» — e sarebbe
   * credibile, che è il motivo per cui nessuno se ne accorgerebbe.
   */
  total: number;
  /** Somma di tutte, in valuta base. */
  totalCents: number;
}

export interface DashboardSummary {
  /** Il giorno dell'utente, nel suo fuso. Non quello del server. */
  today: string;
  baseCurrency: string;
  upcoming: AgendaSectionSummary;
  toConfirm: AgendaSectionSummary;
  overdue: AgendaSectionSummary;
  cancellations: AgendaSectionSummary;
  /** Costo del mese in corso, scadenze previste comprese. */
  currentMonthCents: number;
  /**
   * Media mensile sui dodici mesi **conclusi**, cioè escluso quello in corso.
   *
   * È il metro di paragone del numero sopra: un mese in corso a metà
   * sembrerebbe sempre basso senza qualcosa accanto a cui misurarlo. Includere
   * il mese corrente nella media lo avrebbe schiacciato verso il basso proprio
   * nei giorni in cui lo si guarda.
   */
  monthlyAverageCents: number;
}
