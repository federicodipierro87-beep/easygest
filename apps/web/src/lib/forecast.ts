import {
  BP_SCALE,
  type Forecast,
  type Levers,
  MAX_COST_ADJUSTMENT_BP,
  forecastQuerySchema,
  neutralLevers,
  parseAmountToCents,
} from '@easygest/shared';
import { queryOptions } from '@tanstack/react-query';

import { todayIso } from './format';
import { queryString } from './resources';
import { authFetch } from './session';

/**
 * L'anno e le leve di una simulazione, lette dall'indirizzo.
 *
 * Stesso posto e stesso ruolo di `periodFromParams` per il report: le regole
 * che in un componente vivrebbero dentro un gestore di eventi stanno qui,
 * perché senza DOM un gestore di eventi non si prova.
 *
 * **Tutto lo stato delle leve sta nell'URL**, e le ragioni sono due. La prima è
 * che una simulazione si manda a qualcuno — al commercialista, o a se stessi
 * fra un mese — e `useState` non si incolla. La seconda è che la suite gira in
 * `environment: 'node'`: un cursore non si può né rendere né muovere, mentre un
 * indirizzo si costruisce in una riga e si verifica in un `toContain`.
 *
 * `simulate` invece sta in `@easygest/shared` e non qui: quel pacchetto compila
 * senza DOM e senza Node, dove `URLSearchParams` non esiste. Il confine passa
 * esattamente fra «che cosa vuol dire questo indirizzo» e «che numeri ne
 * escono».
 *
 * **Solo il verso di lettura**, esattamente come `periodFromParams`, che non ha
 * un `periodToParams` accanto. Ogni leva scrive la stringa grezza del proprio
 * controllo dentro i parametri che già ci sono: il cursore dà `'110'`, la
 * casella dà quello che c'è scritto dentro. Ricomporre l'indirizzo da un
 * oggetto `Levers` vorrebbe dire riscrivere `50000` come `50000,00` mentre
 * qualcuno lo sta digitando, cioè combattere con chi scrive.
 */

export const forecastKeys = {
  all: ['forecast'] as const,
  year: (year: number) => ['forecast', year] as const,
};

/**
 * **Nessun `placeholderData: previous`**, per la stessa ragione del report:
 * tenere a schermo i numeri dell'anno precedente mentre arrivano quelli
 * dell'anno chiesto è una lettura sbagliata che dura un secondo e sembra vera,
 * sotto un'intestazione che nel frattempo dice già l'anno nuovo.
 */
export function forecastQueryOptions(year: number) {
  return queryOptions({
    queryKey: forecastKeys.year(year),
    queryFn: () => authFetch<Forecast>(`/forecast?${queryString([['year', String(year)]])}`),
    staleTime: 60_000,
  });
}

/**
 * L'anno scritto nell'indirizzo, o quello in corso.
 *
 * A differenza del periodo del report, qui un anno malfatto **non** si mostra
 * com'è: `/report?from=…` senza estremi validi ha un messaggio da scrivere e
 * due caselle da riempire, mentre `?anno=duemila` non ha nessuna casella che
 * possa contenerlo — la tendina ha tre voci. Ricadere sull'anno in corso è
 * l'unica risposta che non lascia la pagina senza domanda.
 *
 * Lo schema è quello che l'API usa per validare la query, non una copia: gli
 * estremi restano scritti in un posto solo.
 */
export function yearFromParams(params: URLSearchParams, today: string = todayIso()): number {
  const current = Number(today.slice(0, 4));
  const raw = params.get('anno');
  if (raw === null) return current;
  const parsed = forecastQuerySchema.safeParse({ year: raw });
  return parsed.success ? parsed.data.year : current;
}

/**
 * Gli anni che la tendina offre: quello scorso, questo, il prossimo.
 *
 * Tre e non dieci. Indietro c'è il report, che di un anno chiuso dice la stessa
 * cosa con più dettaglio; avanti la previsione si allontana da qualunque dato
 * reale — il secondo anno sarebbe interamente sintetico, cioè la ricorrenza
 * delle spese di oggi moltiplicata per dodici. Un anno fuori elenco resta
 * comunque raggiungibile scrivendolo nell'indirizzo.
 */
export function yearChoices(today: string = todayIso()): number[] {
  const current = Number(today.slice(0, 4));
  return [current - 1, current, current + 1];
}

/** Un numero in centesimi da un parametro scritto in unità, o `null`. */
function hundredths(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null) return null;
  return parseAmountToCents(raw);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Un'aliquota dall'indirizzo, o `null` se non c'è: `0` è un valore, non un'assenza. */
function rateFrom(params: URLSearchParams, name: string): number | null {
  const parsed = hundredths(params, name);
  return parsed === null ? null : clamp(parsed, 0, BP_SCALE);
}

/**
 * Le leve scritte nell'indirizzo.
 *
 * `?fatturato=50000&escluse=a,b&costi=110&extra=200`, più `coefficiente`,
 * `inps` e `sostitutiva` quando si provano aliquote diverse da quelle salvate.
 * L'anno non è una leva: è la domanda, e la legge `yearFromParams`.
 *
 * Gli importi si scrivono in euro e le aliquote in percento, perché un
 * indirizzo si legge e si corregge a mano. Che `parseAmountToCents` serva per
 * entrambi non è un trucco: centesimi di euro e basis point sono la stessa
 * scala — cento per unità — ed è la stessa identità su cui
 * `percentFromBasisPoints` è scritta.
 *
 * Un parametro illeggibile torna al valore neutro **invece di far fallire la
 * pagina**. È l'opposto della regola dei moduli — «rifiutare invece di
 * riparare» — e la differenza è che lì c'è una casella da colorare di rosso,
 * qui c'è solo un indirizzo incollato male da cui non si torna indietro.
 */
export function leversFromParams(params: URLSearchParams): Levers {
  const revenue = hundredths(params, 'fatturato');
  const cost = hundredths(params, 'costi');
  const extra = hundredths(params, 'extra');

  const levers: Levers = {
    ...neutralLevers(),
    revenueCents: revenue === null ? 0 : Math.max(0, revenue),
    excludedExpenseIds: (params.get('escluse') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
    costAdjustmentBp: cost === null ? BP_SCALE : clamp(cost, 0, MAX_COST_ADJUSTMENT_BP),
    extraMonthlyCents: extra === null ? 0 : Math.max(0, extra),
  };

  const coefficient = rateFrom(params, 'coefficiente');
  const inps = rateFrom(params, 'inps');
  const substitute = rateFrom(params, 'sostitutiva');
  const rates: NonNullable<Levers['rates']> = {};
  if (coefficient !== null) rates.profitabilityCoefficientBp = coefficient;
  if (inps !== null) rates.inpsRateBp = inps;
  if (substitute !== null) rates.substituteTaxRateBp = substitute;
  if (Object.keys(rates).length > 0) levers.rates = rates;

  return levers;
}
