import { type ForecastRow, type ForecastSummary, foldForecast } from './forecast';
import { type BasisPoints, type Cents, BP_SCALE, applyBasisPoints } from './money';
import { formatIsoDate, generateSchedule, parseIsoDate, utcDay } from './recurrence';
import type { Settings } from './settings';
import { type ForfettarioResult, foldForfettario } from './taxes';

/**
 * Le leve, e cosa succede a tirarle.
 *
 * Funzione **pura**, con «oggi» passato e mai letto dall'orologio: è la regola
 * di `recurrence.ts`, e senza di essa le prove cambierebbero risposta a seconda
 * del giorno in cui girano — il che è il modo più efficace di avere una suite
 * verde che non prova niente.
 *
 * ## Le leve sui costi non muovono le imposte
 *
 * È il fatto di dominio che regge l'intera pagina, e va letto qui prima che
 * altrove. Nel forfettario i costi **non si deducono**: il coefficiente di
 * redditività li sostituisce in blocco, quindi una spesa in più riduce quanto
 * resta in tasca e lascia l'imposta dov'era, al centesimo. Chi legge questo
 * modulo cercando dove i costi entrano nel conto fiscale deve non trovarlo, e
 * `simulator.test.ts` ha una prova il cui unico compito è impedire che qualcuno
 * ce li metta «correggendo un errore».
 *
 * ## La percentuale tocca solo il futuro
 *
 * Ritoccare del 10 % un costo di febbraio quando febbraio è passato non è una
 * simulazione: è una falsificazione dello storico, ed è esattamente il numero
 * che poi non torna col report. Stessa ragione per cui la spesa ipotetica parte
 * da oggi e non dal primo gennaio: non si immagina di aver speso.
 *
 * ## Le leve nell'indirizzo stanno altrove
 *
 * `leversFromParams` e `leversToParams` vivono in `apps/web/src/lib/forecast.ts`,
 * accanto a `periodFromParams` che fa lo stesso lavoro per il report. Non è una
 * scelta di gusto: questo pacchetto compila con `lib: ["ES2023"]` e `types: []`,
 * cioè senza DOM e senza Node, e `URLSearchParams` non esiste in nessuno dei
 * due. Tenerlo platform-free è ciò che permette allo stesso `simulate` di girare
 * nel browser e nell'API.
 */

/** L'id della spesa che non esiste: non è un cuid, e non può collidere. */
export const HYPOTHETICAL_EXPENSE_ID = 'ipotetica';
export const HYPOTHETICAL_EXPENSE_NAME = 'Spesa ipotetica';

/**
 * Il tetto della percentuale sui costi: dieci volte.
 *
 * Il cursore a schermo vive fra il 50 % e il 200 %; questo è il limite oltre il
 * quale `leversFromParams` tronca un valore scritto a mano nell'indirizzo, per
 * non far uscire una cifra assurda con l'aria di una previsione.
 */
export const MAX_COST_ADJUSTMENT_BP = 100_000;

export interface Levers {
  revenueCents: Cents;
  /** Le spese spuntate via: escono dai costi, non dalle imposte. */
  excludedExpenseIds: string[];
  /** `10_000` è «invariato». */
  costAdjustmentBp: BasisPoints;
  /** Una spesa mensile che non c'è, da oggi a fine anno. */
  extraMonthlyCents: Cents;
  /**
   * Le aliquote solo per la simulazione.
   *
   * Parziale e opzionale: una chiave assente significa «quella salvata in
   * `Settings`», non «zero». È la differenza fra provare un coefficiente
   * diverso e azzerare per sbaglio i contributi.
   */
  rates?: Partial<
    Pick<Settings, 'substituteTaxRateBp' | 'profitabilityCoefficientBp' | 'inpsRateBp'>
  >;
}

export interface SimulationContext {
  settings: Settings;
  /** Il giorno del taglio, come l'ha mandato l'API: non si ricalcola qui. */
  today: string;
  year: number;
}

export interface SimulationResult {
  revenueCents: Cents;
  /**
   * Il conto del forfettario con le aliquote in vigore per questa simulazione.
   *
   * `contributionsPaidCents` resta al valore di competenza: il simulatore non
   * sa quali F24 siano stati pagati davvero, e fingere di saperlo sarebbe
   * peggio del limite dichiarato nel registro.
   */
  taxes: ForfettarioResult;
  /** Le righe dopo le leve: escluse tolte, futuro ritoccato, ipotetica in coda. */
  rows: ForecastRow[];
  summary: ForecastSummary;
  /** Fatturato meno contributi, imposta e costi: la risposta alla domanda. */
  netCents: Cents;
}

/** Le leve ferme: nessuna esclusione, costi invariati, niente di ipotetico. */
export function neutralLevers(): Levers {
  return {
    revenueCents: 0,
    excludedExpenseIds: [],
    costAdjustmentBp: BP_SCALE,
    extraMonthlyCents: 0,
  };
}

/**
 * Le date della spesa ipotetica: mensile, dal più avanti fra oggi e il 1° gennaio.
 *
 * `generateSchedule` invece di dodici date scritte a mano, perché è lui a sapere
 * cosa succede al 31: una spesa ipotetica ancorata al 31 marzo cade il 30 aprile,
 * e una terza idea di «un mese dopo» in questo programma sarebbe una di troppo.
 * Il `from` è lo stesso della previsione vera in `services/forecast.ts`, così il
 * confine fra reale e ipotetico è uno solo.
 */
function hypotheticalRows(monthlyCents: Cents, today: Date, year: number): ForecastRow[] {
  if (monthlyCents === 0) return [];

  const yearStart = utcDay(year, 1, 1);
  const yearEnd = utcDay(year, 12, 31);
  const from = today > yearStart ? today : yearStart;
  if (from > yearEnd) return [];

  return generateSchedule({
    start: from,
    unit: 'MONTH',
    interval: 1,
    until: yearEnd,
    from,
  }).map((date) => ({
    occurrenceId: null,
    expenseId: HYPOTHETICAL_EXPENSE_ID,
    expenseName: HYPOTHETICAL_EXPENSE_NAME,
    vendorName: null,
    categoryName: null,
    dueDate: formatIsoDate(date),
    baseGrossCents: monthlyCents,
    source: 'previsione',
    status: null,
  }));
}

/** Lo stesso ordine dell'API, perché la riga ipotetica non finisca in fondo. */
function byDueDateThenName(a: ForecastRow, b: ForecastRow): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.expenseName === b.expenseName) return 0;
  return a.expenseName < b.expenseName ? -1 : 1;
}

export function simulate(
  rows: readonly ForecastRow[],
  levers: Levers,
  context: SimulationContext,
): SimulationResult {
  const today = parseIsoDate(context.today);
  if (today === null) {
    // Il confronto fra stringhe qui sotto non fallirebbe: direbbe soltanto che
    // tutto è passato, e la percentuale sui costi smetterebbe di fare effetto
    // senza che niente lo segnali.
    throw new Error(`«Oggi» non è una data: ${context.today}`);
  }

  const excluded = new Set(levers.excludedExpenseIds);
  const adjusted: ForecastRow[] = [];
  for (const row of rows) {
    if (excluded.has(row.expenseId)) continue;
    const touchable = row.dueDate >= context.today && levers.costAdjustmentBp !== BP_SCALE;
    adjusted.push(
      touchable
        ? { ...row, baseGrossCents: applyBasisPoints(row.baseGrossCents, levers.costAdjustmentBp) }
        : row,
    );
  }
  // La percentuale non tocca l'ipotetica: sono due leve, e moltiplicarle
  // renderebbe il risultato di ognuna dipendente dall'altra.
  adjusted.push(...hypotheticalRows(levers.extraMonthlyCents, today, context.year));
  adjusted.sort(byDueDateThenName);

  const summary = foldForecast(adjusted, { year: context.year });

  const rates = levers.rates ?? {};
  const taxes = foldForfettario({
    revenueCents: levers.revenueCents,
    profitabilityCoefficientBp:
      rates.profitabilityCoefficientBp ?? context.settings.profitabilityCoefficientBp,
    inpsRateBp: rates.inpsRateBp ?? context.settings.inpsRateBp,
    substituteTaxRateBp: rates.substituteTaxRateBp ?? context.settings.substituteTaxRateBp,
  });

  return {
    revenueCents: levers.revenueCents,
    taxes,
    rows: adjusted,
    summary,
    netCents: levers.revenueCents - taxes.totalDueCents - summary.totalCents,
  };
}
