import {
  type ForecastExpense,
  type ForecastMonth,
  type SimulationResult,
  type Settings,
  foldForecast,
  formatBasisPoints,
  revenueWarning,
  simulate,
  simulatorRefusal,
} from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import {
  forecastQueryOptions,
  leversFromParams,
  yearChoices,
  yearFromParams,
} from '@/lib/forecast';
import { settingsQueryOptions } from '@/lib/settings';

/**
 * «Quanto mi resta?»
 *
 * Si scrive il fatturato dell'anno, si vedono contributi, imposta e costi
 * previsti, e si muovono le leve per capire cosa cambia.
 *
 * **Tutto lo stato delle leve sta nell'URL**, per le due ragioni scritte in
 * `lib/forecast.ts`: una simulazione si manda a qualcuno, e la suite gira in
 * `environment: 'node'`, dove un cursore non si può né rendere né muovere
 * mentre un indirizzo si costruisce in una riga. È la stessa scelta di
 * `ReportPage`.
 *
 * Ogni leva scrive **la stringa grezza del proprio controllo** dentro i
 * parametri che già ci sono, invece di ricomporre l'indirizzo da un oggetto
 * `Levers`. È di nuovo il modo di `ReportPage`, e la ragione è che una casella
 * controllata che riscrive `50000` come `50000,00` mentre si digita
 * combatte con chi sta scrivendo. Il verso di lettura — indirizzo → leve —
 * resta invece una funzione pura e provata.
 *
 * Il conto sta **sopra** le leve perché è la risposta, e le leve sono la
 * domanda: si guarda il netto e si muove qualcosa, non il contrario.
 */

/** `2027-03` → `03/2027`, come nel report. */
function formatMonth(month: string): string {
  return `${month.slice(5, 7)}/${month.slice(0, 4)}`;
}

/** Una riga del conto: etichetta a sinistra, importo a destra. */
function Line({
  label,
  amount,
  currency,
  hint,
  strong,
}: {
  label: string;
  amount: number;
  currency: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 ${strong === true ? 'border-t pt-3' : ''}`}
    >
      <div>
        <span className={strong === true ? 'font-medium' : ''}>{label}</span>
        {hint !== undefined && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      <span
        className={`tabular-nums ${strong === true ? 'text-xl font-semibold' : ''} ${
          amount < 0 ? 'text-red-600' : ''
        }`}
      >
        {formatMoney(amount, currency)}
      </span>
    </div>
  );
}

/**
 * Il conto, dal fatturato al netto in tasca.
 *
 * I costi stanno sotto l'imposta e **non** dentro la base imponibile, e fra i
 * due c'è la riga che spiega perché: nel forfettario i costi non riducono le
 * imposte, riducono solo quanto resta. È l'unica frase della pagina che
 * qualcuno leggerà due volte, ed è il motivo per cui la pagina esiste.
 *
 * `netCents` sparisce quando una spesa non si è potuta convertire. Un netto
 * calcolato su costi incompleti sarebbe più alto del vero, credibile, e
 * nessuno avrebbe modo di accorgersene: un totale che manca si vede, un totale
 * sbagliato no.
 */
function Reckoning({
  result,
  currency,
  coefficientBp,
  unconvertedCount,
}: {
  result: SimulationResult;
  currency: string;
  coefficientBp: number;
  unconvertedCount: number;
}) {
  return (
    <section className="grid gap-3 rounded-xl border p-5">
      <Line label="Fatturato" amount={result.revenueCents} currency={currency} />
      <Line
        label="Imponibile"
        amount={result.taxes.taxableCents}
        currency={currency}
        hint={`${formatBasisPoints(coefficientBp)} del fatturato, per coefficiente di redditività`}
      />
      <Line
        label="Contributi INPS"
        amount={-result.taxes.inpsCents}
        currency={currency}
        hint="Di competenza dell’anno, non di cassa"
      />
      <Line
        label="Imposta sostitutiva"
        amount={-result.taxes.substituteTaxCents}
        currency={currency}
        hint="Sull’imponibile meno i contributi"
      />
      {/* Due righe e non una, perché il cursore ne muove solo la seconda: con
          un totale unico si vede cambiare un quarto della cifra senza sapere
          quale quarto, ed è il modo più rapido per far dubitare di un numero
          giusto. La divisione arriva da `simulate`, che il confine di oggi lo
          attraversa già per decidere cosa ritoccare. */}
      <Line
        label="Costi fino a oggi"
        amount={-result.settledCents}
        currency={currency}
        hint="Già maturati: le leve non li toccano"
      />
      <Line
        label="Costi da oggi a fine anno"
        amount={-result.upcomingCents}
        currency={currency}
        hint={`È su questi che agisce la percentuale · ${String(result.summary.count)} scadenze in tutto l’anno`}
      />

      {unconvertedCount > 0 ? (
        <div className="border-t pt-3">
          <p className="font-medium">Netto in tasca</p>
          <p className="mt-1 text-sm text-red-600">
            Non calcolabile: manca il cambio per alcune spese, e i costi qui sopra sono incompleti.
          </p>
        </div>
      ) : (
        <Line label="Netto in tasca" amount={result.netCents} currency={currency} strong />
      )}

      <p className="text-muted-foreground border-t pt-3 text-xs">
        Nel forfettario i costi non riducono le imposte: riducono solo quanto resta. Togliendo una
        spesa qui sotto, il netto sale e imposta e contributi non si muovono di un centesimo.
      </p>
    </section>
  );
}

/**
 * Le leve.
 *
 * Il cursore sui costi vive fra il 50 % e il 200 %: sotto la metà si sta
 * immaginando un'altra attività, sopra il doppio il numero smette di somigliare
 * a una previsione. Un valore fuori scala resta scrivibile nell'indirizzo, dove
 * `leversFromParams` lo tronca al decuplo.
 *
 * Le spese da escludere si elencano **dalle righe non filtrate**, non da
 * `result.summary.byExpense`: quelle sono già passate per le leve, e una spesa
 * tolta sparirebbe dall'elenco senza più un modo per rimetterla.
 */
function Levers({
  params,
  write,
  expenses,
  currency,
  costPercent,
  excluded,
}: {
  params: URLSearchParams;
  write: (changes: Record<string, string>) => void;
  expenses: ForecastExpense[];
  currency: string;
  costPercent: number;
  excluded: Set<string>;
}) {
  return (
    <section className="grid gap-5 rounded-xl border p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="fatturato">Fatturato previsto</Label>
          <Input
            id="fatturato"
            inputMode="decimal"
            placeholder="50000"
            value={params.get('fatturato') ?? ''}
            onChange={(event) => {
              write({ fatturato: event.target.value });
            }}
          />
          <p className="text-muted-foreground text-xs">
            In euro. Non si salva da nessuna parte: le fatture attive non esistono ancora.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="extra">Spesa mensile ipotetica</Label>
          <Input
            id="extra"
            inputMode="decimal"
            placeholder="0"
            value={params.get('extra') ?? ''}
            onChange={(event) => {
              write({ extra: event.target.value });
            }}
          />
          <p className="text-muted-foreground text-xs">
            Si aggiunge da oggi a fine anno: non si immagina di aver speso.
          </p>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="costi">{`Costi futuri al ${String(costPercent)} %`}</Label>
        <input
          id="costi"
          type="range"
          min={50}
          max={200}
          step={5}
          value={costPercent}
          className="accent-primary w-full max-w-sm"
          onChange={(event) => {
            write({ costi: event.target.value === '100' ? '' : event.target.value });
          }}
        />
        <p className="text-muted-foreground text-xs">
          Tocca solo le scadenze da oggi in poi: ritoccare un costo già pagato non è una
          simulazione.
        </p>
      </div>

      {expenses.length > 0 && (
        <div className="grid gap-2">
          <p className="text-sm font-medium">Spese da togliere</p>
          {expenses.map((expense) => {
            const off = excluded.has(expense.expenseId);
            return (
              <div key={expense.expenseId} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={`escludi-${expense.expenseId}`}
                  checked={off}
                  onCheckedChange={(next) => {
                    const ids = new Set(excluded);
                    if (next === true) ids.add(expense.expenseId);
                    else ids.delete(expense.expenseId);
                    write({ escluse: [...ids].join(',') });
                  }}
                />
                <Label htmlFor={`escludi-${expense.expenseId}`} className="font-normal">
                  {expense.expenseName}
                </Label>
                <span className="text-muted-foreground ml-auto tabular-nums">
                  {formatMoney(expense.totalCents, currency)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** I dodici mesi, con reale e previsto in colonne separate. */
function MonthTable({ months, currency }: { months: ForecastMonth[]; currency: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Mese</TableHead>
          <TableHead className="text-right">Reale</TableHead>
          <TableHead className="text-right">Previsto</TableHead>
          <TableHead className="text-right">Totale</TableHead>
          <TableHead className="text-right">Scadenze</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {months.map((month) => (
          <TableRow key={month.month}>
            <TableCell className="tabular-nums">{formatMonth(month.month)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatMoney(month.realCents, currency)}
            </TableCell>
            <TableCell className="text-muted-foreground text-right tabular-nums">
              {formatMoney(month.forecastCents, currency)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatMoney(month.realCents + month.forecastCents, currency)}
            </TableCell>
            <TableCell className="text-muted-foreground text-right tabular-nums">
              {month.count}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Il conto, le leve e i mesi: tutto ciò che richiede un regime forfettario. */
function Simulator({
  settings,
  params,
  write,
  year,
}: {
  settings: Settings;
  params: URLSearchParams;
  write: (changes: Record<string, string>) => void;
  year: number;
}) {
  const forecast = useQuery(forecastQueryOptions(year));
  const levers = leversFromParams(params);

  if (forecast.isPending) return <p className="text-muted-foreground text-sm">Caricamento…</p>;
  if (forecast.isError) {
    return (
      <p className="text-sm text-red-600">
        {forecast.error instanceof ApiError
          ? forecast.error.message
          : 'Errore imprevisto durante la lettura.'}
      </p>
    );
  }

  const data = forecast.data;
  const currency = data.baseCurrency;
  const result = simulate(data.rows, levers, { settings, today: data.today, year });
  // Dalle righe **non** filtrate: le spese già tolte devono restare spuntabili.
  const expenses = foldForecast(data.rows, { year }).byExpense;
  const warning = revenueWarning(levers.revenueCents);

  return (
    <>
      {warning !== null && <p className="text-sm text-red-600">{warning}</p>}

      <Reckoning
        result={result}
        currency={currency}
        coefficientBp={
          levers.rates?.profitabilityCoefficientBp ?? settings.profitabilityCoefficientBp
        }
        unconvertedCount={data.unconverted.length}
      />

      <Levers
        params={params}
        write={write}
        expenses={expenses}
        currency={currency}
        costPercent={Math.round(levers.costAdjustmentBp / 100)}
        excluded={new Set(levers.excludedExpenseIds)}
      />

      {data.unconverted.length > 0 && (
        <p className="text-sm text-red-600">
          {`Senza cambio, ed escluse dai costi: ${data.unconverted
            .map((one) => `${one.expenseName} (${one.currency})`)
            .join(', ')}.`}
        </p>
      )}

      <section className="rounded-xl border">
        <h2 className="border-b px-5 py-3 text-sm font-medium">Mese per mese</h2>
        <MonthTable months={result.summary.byMonth} currency={currency} />
      </section>
    </>
  );
}

export function ForecastPage() {
  const [params, setParams] = useSearchParams();
  const year = yearFromParams(params);
  const settings = useQuery(settingsQueryOptions());

  /**
   * Una leva scrive dentro i parametri che già ci sono, con `replace`.
   *
   * Un cursore emette un `onChange` per ogni tacca e una casella per ogni
   * tasto: senza `replace`, muovere il cursore dal 100 % al 150 % lascerebbe
   * dieci voci nella cronologia, e il tasto «indietro» servirebbe dieci volte
   * per tornare da dove si è arrivati. È la stessa ragione di `ReportPage`.
   *
   * L'anno si riscrive sempre, anche quando è quello in corso: un indirizzo
   * mandato a dicembre e aperto a gennaio mostrerebbe un altro anno, con gli
   * stessi numeri di fatturato accanto.
   */
  function write(changes: Record<string, string>) {
    const next = new URLSearchParams(params);
    next.set('anno', String(year));
    for (const [name, value] of Object.entries(changes)) {
      if (value === '') next.delete(name);
      else next.set(name, value);
    }
    setParams(next, { replace: true });
  }

  const refusal = settings.data === undefined ? null : simulatorRefusal(settings.data);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Previsioni</h1>

        {/*
          Una tendina nativa e non `SelectField`: qui non c'è un modulo da
          etichettare né un errore da collegare, c'è l'argomento della rotta —
          tre voci, e il suo posto è accanto al titolo come le date del report.
        */}
        <div className="flex items-center gap-2 text-sm">
          <Label htmlFor="anno" className="text-muted-foreground">
            Anno
          </Label>
          <select
            id="anno"
            className="border-input h-9 rounded-md border px-2 text-sm"
            value={year}
            onChange={(event) => {
              write({ anno: event.target.value });
            }}
          >
            {/* L'anno chiesto entra comunque nell'elenco: `?anno=2020` è
                raggiungibile a mano, e una tendina che non contiene il proprio
                valore si mostra vuota. */}
            {[...new Set([...yearChoices(), year])]
              .sort((a, b) => a - b)
              .map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
          </select>
        </div>
      </header>

      {settings.isPending ? (
        <p className="text-muted-foreground text-sm">Caricamento…</p>
      ) : settings.isError ? (
        <p className="text-sm text-red-600">Non è stato possibile leggere le impostazioni.</p>
      ) : refusal !== null ? (
        /*
          Il rifiuto sostituisce tutto, e non affianca un conto grigio: un
          numero del forfettario mostrato a chi è in ordinario è credibile e
          falso, ed è peggio di nessun numero.
        */
        <section className="grid gap-3 rounded-xl border p-5 text-sm">
          <p>{refusal}</p>
          <p className="text-muted-foreground">
            Se il regime è sbagliato si cambia in{' '}
            <Link to="/impostazioni/fisco" className="underline">
              Impostazioni → Fisco
            </Link>
            .
          </p>
        </section>
      ) : (
        settings.data !== undefined && (
          <Simulator settings={settings.data} params={params} write={write} year={year} />
        )
      )}
    </div>
  );
}
