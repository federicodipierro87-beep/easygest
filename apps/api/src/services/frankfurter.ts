import { formatIsoDate, parseIsoDate } from '@easygest/shared';
import { z } from 'zod';

import { Prisma, type PrismaClient } from '../generated/prisma/client';

/**
 * Recupero dei tassi di cambio dalla BCE, tramite Frankfurter.
 *
 * Frankfurter ripubblica i tassi di riferimento della Banca Centrale Europea:
 * niente chiave d'accesso, niente quota, e una fonte che un commercialista
 * riconosce. Sono pubblicati nei giorni lavorativi verso le 16, quindi un
 * giorno festivo semplicemente non esiste nella risposta — non è un errore, ed
 * è il motivo per cui `findRate` sa guardare indietro di qualche giorno.
 *
 * Questo modulo è arrivato in Fase 2 e non in Fase 4 perché senza tassi una
 * spesa in valuta estera non si può nemmeno creare: il cron della Fase 4 dovrà
 * solo chiamare `syncFxRates` a orario, non scriverlo.
 */

export const FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v1';

/** Le valute che si sincronizzano, finché non ce ne sarà una da configurare. */
export const TRACKED_CURRENCIES = ['USD', 'GBP', 'CHF'] as const;

/**
 * La risposta, letta con uno schema invece che a fiducia.
 *
 * È un servizio di terzi: se un giorno cambia forma, il punto in cui accorgersene
 * dev'essere il confine, non una riga di database con dentro `undefined`.
 */
const frankfurterResponseSchema = z.object({
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

/** Iniettata nei test: nessuna rete durante la suite. */
export type Fetcher = (url: string) => Promise<unknown>;

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Frankfurter ha risposto ${String(response.status)} per ${url}`);
  }
  return response.json();
};

export interface SyncResult {
  /** Il giorno dei tassi ricevuti, che può essere anteriore a quello chiesto. */
  date: Date;
  written: number;
}

/**
 * Scarica i tassi e li scrive, saltando quelli che ci sono già.
 *
 * Il verso è quello che serve alla conversione: `EUR` come base e la valuta
 * estera come quotata, cioè quanti euro vale un dollaro. Frankfurter pubblica
 * l'inverso — quanti dollari vale un euro — quindi il tasso viene rovesciato
 * qui, una volta sola, invece di ricordarsene a ogni lettura.
 *
 * `createMany` con `skipDuplicates` fa il lavoro dell'idempotenza appoggiandosi
 * al vincolo unico su `(base, quote, date)`: rilanciare il job due volte nello
 * stesso giorno non duplica niente e non fallisce.
 */
export async function syncFxRates(
  prisma: PrismaClient,
  options: {
    baseCurrency?: string;
    currencies?: readonly string[];
    on?: Date;
    fetcher?: Fetcher;
  } = {},
): Promise<SyncResult> {
  const baseCurrency = options.baseCurrency ?? 'EUR';
  const currencies = (options.currencies ?? TRACKED_CURRENCIES).filter(
    (currency) => currency !== baseCurrency,
  );
  const fetcher = options.fetcher ?? defaultFetcher;

  if (currencies.length === 0) return { date: options.on ?? new Date(), written: 0 };

  // Frankfurter accetta una data o `latest`. Chiedere una data futura o odierna
  // prima delle 16 restituisce comunque l'ultimo giorno pubblicato, che è il
  // comportamento voluto.
  const day = options.on === undefined ? 'latest' : formatIsoDate(options.on);
  const url = `${FRANKFURTER_BASE_URL}/${day}?base=${baseCurrency}&symbols=${currencies.join(',')}`;

  const parsed = frankfurterResponseSchema.safeParse(await fetcher(url));
  if (!parsed.success) {
    throw new Error(`Risposta di Frankfurter non riconosciuta: ${parsed.error.message}`);
  }

  const date = parseIsoDate(parsed.data.date);
  if (date === null) {
    throw new Error(`Frankfurter ha restituito una data illeggibile: ${parsed.data.date}`);
  }

  const rows = Object.entries(parsed.data.rates)
    .filter(([, rate]) => rate > 0)
    .map(([quote, rate]) => ({
      base: baseCurrency,
      quote,
      date,
      // Il rovesciamento: da «un euro vale 1,09 dollari» a «un dollaro vale
      // 0,917 euro», che è il fattore per cui si moltiplica un importo in
      // dollari. In `Decimal` perché il reciproco di 1,09 è periodico, e dieci
      // decimali di un periodico calcolato in virgola mobile non sono gli
      // stessi dieci decimali. Sono anche esattamente quanti ne tiene la colonna.
      rate: new Prisma.Decimal(1).dividedBy(rate).toFixed(10, Prisma.Decimal.ROUND_HALF_UP),
      source: 'frankfurter',
    }));

  const result = await prisma.fxRate.createMany({ data: rows, skipDuplicates: true });
  return { date, written: result.count };
}
