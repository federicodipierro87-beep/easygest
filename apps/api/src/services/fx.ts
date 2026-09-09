import { EXPENSE_ERROR_CODES, formatIsoDate } from '@easygest/shared';

import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { ResourceError } from '../lib/resources';

/**
 * Il cambio da usare per convertire un'occorrenza nella valuta base.
 *
 * Il tasso viene letto dal database, mai dalla rete: la generazione delle
 * occorrenze è un percorso di scrittura, e farlo dipendere da un servizio
 * esterno significherebbe che creare una spesa fallisce quando la BCE ha un
 * problema. Il recupero dei tassi è un lavoro separato e periodico
 * (`frankfurter.ts`), e questo modulo legge quello che ha trovato.
 */

/**
 * Quanto indietro si accetta di guardare per un tasso mancante.
 *
 * I tassi BCE escono nei giorni lavorativi: per un'occorrenza che cade di
 * domenica il tasso del venerdì è la risposta giusta, non un ripiego. Dieci
 * giorni coprono un ponte lungo o una sincronizzazione saltata per qualche
 * giorno; oltre, il tasso è vecchio abbastanza da essere una notizia, e vale
 * la pena fermarsi invece di convertire con un numero della settimana scorsa
 * senza dirlo a nessuno.
 */
export const MAX_RATE_STALENESS_DAYS = 10;

export interface ResolvedRate {
  /** Il fattore per cui moltiplicare un importo in `quote` per ottenerlo in `base`. */
  rate: string;
  /** Il giorno del tasso, che può essere anteriore a quello richiesto. */
  date: Date;
}

export function missingFxRate(base: string, quote: string, on: Date): ResourceError {
  return new ResourceError(
    422,
    EXPENSE_ERROR_CODES.missingFxRate,
    `Nessun cambio ${quote}→${base} disponibile per il ${formatIsoDate(on)}. Sincronizza i tassi e riprova.`,
    { base, quote, date: formatIsoDate(on) },
  );
}

/**
 * Il tasso più recente non successivo alla data richiesta.
 *
 * «Non successivo» è la parte che conta: convertire l'occorrenza di marzo con
 * il cambio di giugno userebbe un'informazione che a marzo non esisteva, e
 * renderebbe il numero irriproducibile. Meglio un tasso di qualche giorno
 * prima, che è quello che avrebbe usato chiunque quel giorno.
 */
export async function findRate(
  prisma: PrismaClient,
  base: string,
  quote: string,
  on: Date,
): Promise<ResolvedRate | null> {
  if (base === quote) {
    // Non è un tasso trovato ma un'identità: cercarlo in tabella vorrebbe dire
    // dipendere dal fatto che qualcuno abbia inserito EUR→EUR = 1.
    return { rate: '1', date: on };
  }

  const row = await prisma.fxRate.findFirst({
    where: { base, quote, date: { lte: on } },
    orderBy: { date: 'desc' },
    select: { rate: true, date: true },
  });
  if (row === null) return null;

  const ageDays = Math.round((on.getTime() - row.date.getTime()) / 86_400_000);
  if (ageDays > MAX_RATE_STALENESS_DAYS) return null;

  return { rate: row.rate.toString(), date: row.date };
}

/**
 * Applica un tasso a un importo in centesimi.
 *
 * La moltiplicazione passa da `Decimal` e non da `Number`. Non è pignoleria:
 * il tasso ha dieci decimali, e `12200 * 1.0873456789` in virgola mobile
 * restituisce un numero che finisce in `...0000000002`. L'arrotondamento lo
 * assorbirebbe quasi sempre — ma «quasi sempre» su un importo è esattamente
 * ciò che la regola degli interi del progetto esiste per evitare.
 *
 * `divideRoundHalfUp` di `money.ts` qui non si può usare: farebbe il conto in
 * interi, e `1e13` centesimi per un tasso scalato a dieci decimali esce dagli
 * interi sicuri di sei ordini di grandezza. Il mezzo cambia, la regola no —
 * half-up, via da zero, come dappertutto.
 *
 * `null` come tasso vuol dire «nessuna conversione», e restituisce l'importo
 * intatto: è il caso della valuta base, e trattarlo qui evita a chi chiama di
 * scriversi un `if` che è già scritto.
 */
export function applyRate(amountCents: number, rate: string | null): number {
  if (rate === null) return amountCents;

  const factor = new Prisma.Decimal(rate);
  if (!factor.isFinite() || factor.lessThanOrEqualTo(0)) {
    throw new Error(`Tasso di cambio inutilizzabile: ${rate}`);
  }
  return factor.times(amountCents).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/** Converte un importo, restituendo anche il tasso da congelare sull'occorrenza. */
export async function convertToBase(
  prisma: PrismaClient,
  amountCents: number,
  currency: string,
  baseCurrency: string,
  on: Date,
): Promise<{ baseCents: number; fxRate: string | null }> {
  if (currency === baseCurrency) {
    // `null` e non `1`: non c'è stata nessuna conversione, e scrivere un tasso
    // farebbe credere che ce ne sia stata una.
    return { baseCents: amountCents, fxRate: null };
  }

  const resolved = await findRate(prisma, baseCurrency, currency, on);
  if (resolved === null) throw missingFxRate(baseCurrency, currency, on);

  // Un tasso illeggibile in tabella è indistinguibile, per chi chiama, da un
  // tasso mancante: in entrambi i casi la conversione non si può fare, e la
  // risposta utile è la stessa.
  let baseCents: number;
  try {
    baseCents = applyRate(amountCents, resolved.rate);
  } catch {
    throw missingFxRate(baseCurrency, currency, on);
  }
  return { baseCents, fxRate: resolved.rate };
}
