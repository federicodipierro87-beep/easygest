import {
  LEDGER_MAX_ROWS,
  addMonths,
  formatIsoDate,
  parseIsoDate,
  reportQuerySchema,
  type ReportLedger,
  type ReportSummary,
} from '@easygest/shared';
import { queryOptions } from '@tanstack/react-query';

import { isoPlusDays, todayIso } from './format';
import { queryString } from './resources';
import { authFetch } from './session';

/**
 * Il periodo di un report, e le due letture che ne dipendono.
 *
 * Tutto quello che si può sbagliare senza accorgersene sta qui invece che
 * dentro la pagina: quale finestra apre un preset, quale periodo si legge da un
 * URL malfatto, quando ci si rifiuta di produrre un file. Sono le regole che in
 * un componente vivrebbero dentro un gestore di eventi, e senza DOM un gestore
 * di eventi non si prova.
 */

export interface ReportPeriod {
  from: string;
  to: string;
}

export type PeriodPreset = 'mese' | 'trimestre' | 'anno' | 'annoScorso';

export const PERIOD_PRESETS: readonly { id: PeriodPreset; label: string }[] = [
  { id: 'mese', label: 'Mese in corso' },
  { id: 'trimestre', label: 'Trimestre' },
  { id: 'anno', label: 'Anno in corso' },
  { id: 'annoScorso', label: 'Anno scorso' },
];

/**
 * L'anno in corso, non il mese.
 *
 * Un report del solo mese corrente ha una serie mensile di una riga, cioè una
 * tabella senza informazione — e il costo del mese è già scritto in dashboard.
 * Sta in un punto solo, quindi cambiarlo resta una riga.
 */
const DEFAULT_PRESET: PeriodPreset = 'anno';

/**
 * L'ultimo giorno del mese di un `YYYY-MM-DD`, qualunque mese sia.
 *
 * Dal primo del mese, un mese avanti è sempre il primo del successivo:
 * `addMonths` tronca il giorno solo quando non esiste, e il primo esiste
 * ovunque. Da lì, un giorno indietro è l'ultimo di questo mese — febbraio
 * compreso, bisestile compreso. È la stessa costruzione di `DueDatesPage`, e
 * resta copiata invece che condivisa: è il secondo uso, non il terzo.
 */
function endOfMonth(firstDay: string): string {
  const first = parseIsoDate(firstDay);
  if (first === null) return firstDay;
  return isoPlusDays(formatIsoDate(addMonths(first, 1)), -1);
}

/**
 * La finestra di un preset, calcolata su `today`.
 *
 * `today` è un parametro e non una costante di modulo: un modulo valutato una
 * volta al caricamento del bundle terrebbe la finestra di quel giorno, e una
 * scheda lasciata aperta una settimana userebbe il mese di sette giorni fa.
 *
 * **Il trimestre è quello di calendario, non gli ultimi novanta giorni.** Una
 * finestra mobile dà un numero che cambia ogni mattina e che non si confronta
 * con quello di ieri, mentre un trimestre ha lo stesso taglio dei modelli
 * fiscali e si confronta con il precedente.
 *
 * **L'anno in corso arriva al 31 dicembre e non a oggi.** Le `PLANNED` contano
 * nei totali: il numero è metà consuntivo e metà impegno preso, e fermarlo a
 * oggi lo renderebbe un consuntivo parziale spacciato per un anno.
 */
export function presetPeriod(preset: PeriodPreset, today: string = todayIso()): ReportPeriod {
  const year = today.slice(0, 4);

  switch (preset) {
    case 'mese': {
      const from = `${today.slice(0, 7)}-01`;
      return { from, to: endOfMonth(from) };
    }
    case 'trimestre': {
      const month = Number(today.slice(5, 7));
      const firstMonth = Math.floor((month - 1) / 3) * 3 + 1;
      const from = `${year}-${String(firstMonth).padStart(2, '0')}-01`;
      const lastMonth = `${year}-${String(firstMonth + 2).padStart(2, '0')}-01`;
      return { from, to: endOfMonth(lastMonth) };
    }
    case 'anno':
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'annoScorso': {
      const previous = String(Number(year) - 1).padStart(4, '0');
      return { from: `${previous}-01-01`, to: `${previous}-12-31` };
    }
  }
}

/** Quale preset descrive esattamente questo periodo, se ce n'è uno. */
export function activePreset(
  period: ReportPeriod,
  today: string = todayIso(),
): PeriodPreset | null {
  for (const preset of PERIOD_PRESETS) {
    const candidate = presetPeriod(preset.id, today);
    if (candidate.from === period.from && candidate.to === period.to) return preset.id;
  }
  return null;
}

/**
 * Il periodo scritto nell'URL, senza correzioni in silenzio.
 *
 * Tre casi e tre risposte. Mancano entrambi i parametri: si apre sul default.
 * Ne manca uno: default intero, perché mezzo periodo è una domanda ambigua e
 * inventare l'altro estremo vorrebbe dire scegliere al posto di chi ha scritto
 * l'indirizzo. Ci sono entrambi: quello che c'è scritto, **anche se è
 * spazzatura** — a rifiutarlo pensa `periodError`, con un messaggio.
 *
 * Scivolare su un periodo vicino mostrerebbe numeri veri attribuiti al periodo
 * sbagliato, che è il difetto esatto contro cui esiste `reportQuerySchema`.
 */
export function periodFromParams(params: URLSearchParams, today?: string): ReportPeriod {
  const from = params.get('from');
  const to = params.get('to');
  if (from === null || to === null) return presetPeriod(DEFAULT_PRESET, today);
  return { from, to };
}

/**
 * Il messaggio con cui il server rifiuterebbe questo periodo, o `null`.
 *
 * Non riscrive le regole: chiama lo schema che l'API usa per validare la query
 * e restituisce il primo messaggio. Sono già in italiano e sono **gli stessi**,
 * parola per parola; riscriverli qui darebbe due formulazioni della stessa
 * regola, destinate a divergere alla prima modifica di una sola delle due.
 */
export function periodError(period: ReportPeriod): string | null {
  const result = reportQuerySchema.safeParse(period);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? 'Periodo non valido';
}

/**
 * Il messaggio con cui ci si rifiuta di produrre un file tagliato, o `null`.
 *
 * È una funzione e non un `if` dentro l'`onClick` per poterla provare: senza
 * DOM un gestore di eventi non si esegue, e questa è la regola che vale il
 * download intero. Un CSV tagliato in silenzio è peggio di nessun CSV, perché
 * chi lo apre somma una colonna incompleta e non ha modo di accorgersene.
 *
 * Il numero viene da `LEDGER_MAX_ROWS` e non è scritto a mano: alzando il
 * tetto sul server, questa frase si aggiorna da sola.
 */
export function exportRefusal(ledger: ReportLedger): string | null {
  if (!ledger.truncated) return null;
  return `Il dettaglio supera le ${String(LEDGER_MAX_ROWS)} righe e verrebbe tagliato: restringi il periodo.`;
}

/**
 * Le chiavi di cache dei report.
 *
 * Riepilogo e dettaglio dello stesso periodo sono due chiavi distinte: sono
 * due rotte, due forme e due momenti — il primo si legge aprendo la pagina, il
 * secondo solo premendo «Esporta».
 */
export const reportKeys = {
  all: ['reports'] as const,
  summary: (period: ReportPeriod) => ['reports', 'summary', period] as const,
  ledger: (period: ReportPeriod) => ['reports', 'ledger', period] as const,
};

function periodQueryString(period: ReportPeriod): string {
  return queryString([
    ['from', period.from],
    ['to', period.to],
  ]);
}

/**
 * **Nessun `placeholderData: previous`**, a differenza di ogni elenco del
 * progetto.
 *
 * Tenere a schermo i numeri del periodo precedente mentre arrivano i nuovi è
 * precisamente «numeri veri attribuiti al periodo sbagliato»: su un elenco è un
 * lampeggio, su un report è una lettura sbagliata che dura un secondo e sembra
 * vera, sotto un'intestazione che nel frattempo dice già il periodo nuovo.
 *
 * `enabled` spegne la lettura su un periodo che il server rifiuterebbe: la
 * richiesta tornerebbe 422 e l'unica cosa che si guadagnerebbe è un messaggio
 * di errore al posto di quello, più preciso, che la pagina mostra già.
 */
export function reportSummaryQueryOptions(period: ReportPeriod) {
  return queryOptions({
    queryKey: reportKeys.summary(period),
    queryFn: () => authFetch<ReportSummary>(`/reports?${periodQueryString(period)}`),
    enabled: periodError(period) === null,
    staleTime: 60_000,
  });
}

export function reportLedgerQueryOptions(period: ReportPeriod) {
  return queryOptions({
    queryKey: reportKeys.ledger(period),
    queryFn: () => authFetch<ReportLedger>(`/reports/ledger?${periodQueryString(period)}`),
    enabled: periodError(period) === null,
    staleTime: 60_000,
    // Cinquemila righe in cache sono memoria che non serve tenere i cinque
    // minuti di default: servono l'istante in cui diventano un `Blob`, e un
    // secondo clic sullo stesso periodo ricade comunque nello `staleTime`.
    gcTime: 60_000,
  });
}
