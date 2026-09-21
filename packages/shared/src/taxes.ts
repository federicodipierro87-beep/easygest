import { type BasisPoints, type Cents, applyBasisPoints } from './money';
import type { Settings } from './settings';

/**
 * Il conto del regime forfettario.
 *
 * `taxes.ts` e non `fiscal.ts`: quel nome è già preso, e non da questo. Là c'è
 * la validazione delle anagrafiche — partita IVA, codice fiscale, codice SDI —
 * che l'italiano chiama «fiscale» esattamente come chiama fiscale un'imposta.
 * Sono due cose diverse e restano in due file diversi.
 *
 * Tutto in interi e tutto via `applyBasisPoints`: nessun `float` tocca un
 * importo, come ovunque nel progetto.
 *
 * **Nel forfettario i costi non si deducono.** Il coefficiente di redditività
 * sostituisce ogni costo reale: il 33 % forfettario *è* la deduzione. Qui
 * dentro non esiste nemmeno un parametro per le spese, ed è di proposito — una
 * spesa riduce quanto resta in tasca, non l'imposta. Chi legge questo modulo
 * cercando dove si sottraggono i costi deve non trovarlo.
 */

export interface ForfettarioInput {
  revenueCents: Cents;
  profitabilityCoefficientBp: BasisPoints;
  inpsRateBp: BasisPoints;
  substituteTaxRateBp: BasisPoints;
  /** Contributi effettivamente versati nell'anno (F24). Default: quelli di competenza. */
  contributionsPaidCents?: Cents;
}

export interface ForfettarioResult {
  /** Fatturato × coefficiente di redditività. */
  taxableCents: Cents;
  /** Imponibile × aliquota INPS: è il contributo di **competenza** dell'anno. */
  inpsCents: Cents;
  /** Imponibile − contributi versati, mai sotto zero. */
  substituteBaseCents: Cents;
  substituteTaxCents: Cents;
  /** Contributi di competenza più imposta sostitutiva. */
  totalDueCents: Cents;
}

/**
 * Imponibile, contributi, imposta.
 *
 * **I contributi si deducono per cassa, non per competenza.** L'art. 1 c. 64
 * della L. 190/2014 deduce i contributi *versati* nell'anno, e quelli di
 * competenza dell'anno *n* si versano fra giugno e novembre dell'anno *n+1*.
 * Per questo `contributionsPaidCents` è un parametro esplicito invece di essere
 * dato per scontato: il default è il valore di competenza, che a regime
 * sbaglia poco — l'errore si compensa fra un anno e l'altro — ma nel primo anno
 * di attività sbaglia di tutto, perché di versato non c'è ancora niente.
 *
 * `substituteBaseCents` non scende sotto zero. Con contributi versati maggiori
 * dell'imponibile — succede al secondo anno, quando saldo e acconto cadono
 * insieme su un imponibile calato — una base negativa produrrebbe un'imposta
 * negativa, cioè un credito che non esiste. L'eccedenza vera si porta in
 * dichiarazione come onere deducibile altrove; qui si tronca a zero, e il
 * troncamento è fra i limiti dichiarati.
 */
export function foldForfettario(input: ForfettarioInput): ForfettarioResult {
  const taxableCents = applyBasisPoints(input.revenueCents, input.profitabilityCoefficientBp);
  const inpsCents = applyBasisPoints(taxableCents, input.inpsRateBp);

  const paid = input.contributionsPaidCents ?? inpsCents;
  const substituteBaseCents = Math.max(0, taxableCents - paid);
  const substituteTaxCents = applyBasisPoints(substituteBaseCents, input.substituteTaxRateBp);

  return {
    taxableCents,
    inpsCents,
    substituteBaseCents,
    substituteTaxCents,
    totalDueCents: inpsCents + substituteTaxCents,
  };
}

/** Oltre questo fatturato si esce dal regime, ma solo dall'anno successivo. */
export const FORFETTARIO_LIMIT_CENTS = 8_500_000;

/** Oltre questo fatturato la decadenza è immediata, nello stesso anno. */
export const FORFETTARIO_HARD_LIMIT_CENTS = 10_000_000;

/**
 * L'avviso sulla soglia, o `null`.
 *
 * Due soglie che sono due cose diverse, e per questo due messaggi.
 *
 * Oltre **85.000 €** si esce dal regime **dall'anno successivo**: i numeri di
 * quest'anno restano validi, e il messaggio deve dirlo o sembrerà che il conto
 * a schermo sia sbagliato.
 *
 * Oltre **100.000 €** la decadenza è **immediata**, nello stesso anno, con IVA
 * dovuta su tutte le operazioni: qui i numeri a schermo non valgono più.
 *
 * Un messaggio solo per i due casi sarebbe falso in uno dei due.
 */
export function revenueWarning(revenueCents: Cents): string | null {
  if (revenueCents > FORFETTARIO_HARD_LIMIT_CENTS) {
    return (
      'Oltre 100.000 € di ricavi il forfettario decade subito, nello stesso anno, con IVA ' +
      'dovuta sulle operazioni: i numeri qui sotto non valgono più.'
    );
  }
  if (revenueCents > FORFETTARIO_LIMIT_CENTS) {
    return (
      'Oltre 85.000 € di ricavi si esce dal forfettario, ma solo dal 1° gennaio dell’anno ' +
      'prossimo: i numeri di quest’anno restano questi.'
    );
  }
  return null;
}

/**
 * Perché non si può simulare, o `null`.
 *
 * Rifiuta l'ordinario invece di approssimarlo. Scaglioni IRPEF, addizionali
 * regionali e comunali e deduzioni reali sono un altro programma, e mostrare
 * il conto del forfettario a chi è in ordinario è peggio che non mostrare
 * niente: sarebbe un numero credibile e falso, su cui qualcuno accantona dei
 * soldi.
 *
 * Funzione pura e separata dalla pagina, come `periodError` ed `exportRefusal`:
 * senza DOM una condizione dentro un JSX non si prova.
 */
export function simulatorRefusal(settings: Settings): string | null {
  if (settings.taxRegime === 'ORDINARIO') {
    return (
      'Le previsioni sanno fare solo il conto del forfettario. In ordinario servono scaglioni ' +
      'IRPEF, addizionali e deduzioni reali, che qui non ci sono: un numero approssimato ' +
      'sarebbe peggio di nessun numero.'
    );
  }
  return null;
}
