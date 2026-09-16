import {
  formatBasisPoints,
  ledgerFileName,
  ledgerToCsv,
  type ReportBucket,
  type ReportClientBucket,
  type ReportMonthBucket,
} from '@easygest/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/download';
import { formatDay, formatMoney } from '@/lib/format';
import {
  PERIOD_PRESETS,
  activePreset,
  exportRefusal,
  periodError,
  periodFromParams,
  presetPeriod,
  reportLedgerQueryOptions,
  reportSummaryQueryOptions,
  type ReportPeriod,
} from '@/lib/reports';

/**
 * Quanto è costato un periodo, a chi è andato, quanto se ne è rimesso in conto.
 *
 * Nessun grafico: quattro tabelle con totale, conteggio e quota. Un grafico
 * richiederebbe una libreria per mostrare dodici numeri che in tabella si
 * leggono già, e che da lì si copiano.
 *
 * **Il periodo sta nell'URL, non in un `useState`.** Su un elenco il filtro è
 * un modo di guardare; qui il periodo *è* la domanda: `/report?from=…&to=…` è
 * quello che si manda al commercialista, si mette nei preferiti e si riapre a
 * gennaio. La stampa futura mette l'indirizzo nel piè di pagina, e con uno
 * stato locale il foglio non direbbe di quale periodo parla.
 *
 * Non è l'inizio a metà della migrazione dichiarata in `DashboardPage`: quel
 * debito riguarda i **filtri degli elenchi**, che vanno portati nella query
 * string tutti insieme. Questo non è un filtro di elenco, è l'argomento della
 * rotta. Il prezzo è che per un po' questa pagina avrà una convenzione diversa
 * dalle altre.
 *
 * Il PDF è la stampa del browser e arriverà dopo. Qui si paga solo il terreno:
 * `print:hidden` sulla sola barra dei comandi, il periodo scritto in chiaro
 * nell'intestazione, e `break-inside-avoid` sulle sezioni perché una tabella
 * non si spezzi a metà fra due pagine.
 */

/** `2027-03` → `03/2027`, senza costruire un `Date`. */
function formatMonth(month: string): string {
  return `${month.slice(5, 7)}/${month.slice(0, 4)}`;
}

/**
 * La serie mensile.
 *
 * Tre componenti locali e non esportati: nessun'altra pagina userà queste
 * tabelle, e un file in `components/` per un uso solo sarebbe un'astrazione
 * costruita per il gusto di averla.
 */
function MonthTable({ months, currency }: { months: ReportMonthBucket[]; currency: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Mese</TableHead>
          <TableHead className="text-right">Totale</TableHead>
          <TableHead className="text-right">Scadenze</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {months.map((month) => (
          <TableRow key={month.month}>
            <TableCell className="tabular-nums">{formatMonth(month.month)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatMoney(month.totalCents, currency)}
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

/** Categorie e fornitori: stessa forma, due usi. */
function BucketTable({
  heading,
  buckets,
  currency,
}: {
  heading: string;
  buckets: ReportBucket[];
  currency: string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{heading}</TableHead>
          <TableHead className="text-right">Totale</TableHead>
          <TableHead className="text-right">Scadenze</TableHead>
          <TableHead className="text-right">Quota</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {buckets.map((bucket) => (
          <TableRow key={bucket.id ?? bucket.label}>
            <TableCell className="font-medium">{bucket.label}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatMoney(bucket.totalCents, currency)}
            </TableCell>
            <TableCell className="text-muted-foreground text-right tabular-nums">
              {bucket.count}
            </TableCell>
            <TableCell className="text-muted-foreground text-right tabular-nums">
              {/* `formatBasisPoints` e non `percentFromBasisPoints`: il secondo
                  è per le caselle dei moduli e darebbe «33,33» senza segno. */}
              {formatBasisPoints(bucket.shareBp)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ClientTable({ buckets, currency }: { buckets: ReportClientBucket[]; currency: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Cliente</TableHead>
          <TableHead className="text-right">Costo</TableHead>
          <TableHead className="text-right">Riaddebito</TableHead>
          <TableHead className="text-right">Margine teorico</TableHead>
          <TableHead className="text-right">Scadenze</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {buckets.map((bucket) => (
          <TableRow key={bucket.id ?? bucket.label}>
            <TableCell className="font-medium">{bucket.label}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatMoney(bucket.totalCents, currency)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatMoney(bucket.rebillCents, currency)}
            </TableCell>
            {/* Il negativo è rosso perché è un'informazione, non un guasto: una
                spesa non riaddebitata ha margine negativo, non assente. */}
            <TableCell
              className={`text-right tabular-nums ${
                bucket.theoreticalMarginCents < 0 ? 'text-red-600' : ''
              }`}
            >
              {formatMoney(bucket.theoreticalMarginCents, currency)}
            </TableCell>
            <TableCell className="text-muted-foreground text-right tabular-nums">
              {bucket.count}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="break-inside-avoid rounded-xl border">
      <h2 className="border-b px-5 py-3 text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

export function ReportPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();

  /** Quello che si vede nelle caselle: sempre e solo ciò che dice l'URL. */
  const shown = periodFromParams(params);

  /**
   * Le due stringhe si ritardano **separatamente**.
   *
   * `useDebouncedValue` confronta per identità: un `{ from, to }` costruito nel
   * rendering sarebbe un oggetto nuovo a ogni giro, il timer ripartirebbe da
   * capo e il valore non convergerebbe mai.
   *
   * Il ritardo serve perché gli stati intermedi di un `<input type="date">`
   * sono date valide ma assurde — digitando `2027` si passa da `0002-03-15` —
   * e senza attesa ognuna sarebbe una richiesta e un messaggio rosso. Il hook
   * si inizializza con il valore, quindi il primo rendering usa già il periodo
   * dell'URL: `renderToString` non vede mai una finestra intermedia.
   */
  const from = useDebouncedValue(shown.from);
  const to = useDebouncedValue(shown.to);
  const asked: ReportPeriod = { from, to };

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const invalid = periodError(asked);
  const summary = useQuery(reportSummaryQueryOptions(asked));
  const data = summary.data;
  const currency = data?.baseCurrency ?? 'EUR';

  /**
   * Scrivere sempre con `replace`.
   *
   * Un `type="date"` emette un `onChange` per ogni stato intermedio: senza,
   * una data digitata a mano lascerebbe una dozzina di voci nella cronologia,
   * e il tasto «indietro» servirebbe dodici volte per tornare da dove si è
   * arrivati.
   */
  function setPeriod(period: ReportPeriod) {
    setParams({ from: period.from, to: period.to }, { replace: true });
  }

  /**
   * L'esportazione con `fetchQuery`, non con una query disabilitata.
   *
   * Il gesto è imperativo e ha quattro passi in sequenza — leggi, rifiuta se
   * tagliato, componi, tocca il DOM — e `fetchQuery` restituisce una promessa:
   * basta un `try/catch`. Con `useQuery({ enabled: false })` e `refetch`, fino
   * a cinquemila righe resterebbero appese al componente e ne provocherebbero
   * un rendering, per dei dati che servono un istante e finiscono in un `Blob`.
   *
   * La cache serve comunque: `fetchQuery` scrive sotto `reportKeys.ledger`
   * rispettando lo `staleTime` delle opzioni, quindi un secondo clic sullo
   * stesso periodo non rifà la richiesta.
   *
   * **`enabled` non vale per `fetchQuery`**: su un periodo non valido la query
   * partirebbe lo stesso. A fermarla è il `disabled` del bottone.
   */
  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    try {
      const ledger = await queryClient.fetchQuery(reportLedgerQueryOptions(asked));
      const refusal = exportRefusal(ledger);
      if (refusal !== null) {
        setExportError(refusal);
        return;
      }
      downloadCsv(
        ledgerFileName(asked.from, asked.to),
        ledgerToCsv(ledger.rows, { baseCurrency: currency }),
      );
    } catch (error) {
      setExportError(
        error instanceof ApiError ? error.message : 'Non è stato possibile leggere il dettaglio.',
      );
    } finally {
      setExporting(false);
    }
  }

  const active = activePreset(shown);
  const empty = data !== undefined && data.count === 0;
  const canExport = !exporting && invalid === null && data !== undefined && data.count > 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Il periodo in chiaro **non** è `print:hidden`: è ciò che rende un
          foglio stampato leggibile da solo, mesi dopo e fuori dal browser. */}
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Report</h1>
        <p className="text-muted-foreground text-sm">
          Dal {formatDay(shown.from)} al {formatDay(shown.to)}
        </p>
      </header>

      <section className="flex flex-col gap-3 print:hidden">
        <div className="flex flex-wrap items-end gap-3">
          {PERIOD_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              variant={active === preset.id ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => {
                setPeriod(presetPeriod(preset.id));
              }}
            >
              {preset.label}
            </Button>
          ))}

          <div className="grid gap-1.5">
            <Label htmlFor="report-from" className="text-muted-foreground text-xs">
              Da
            </Label>
            <Input
              id="report-from"
              type="date"
              className="w-40"
              value={shown.from}
              onChange={(event) => {
                setPeriod({ ...shown, from: event.target.value });
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="report-to" className="text-muted-foreground text-xs">
              a
            </Label>
            <Input
              id="report-to"
              type="date"
              className="w-40"
              value={shown.to}
              onChange={(event) => {
                setPeriod({ ...shown, to: event.target.value });
              }}
            />
          </div>

          <Button
            className="ml-auto"
            size="sm"
            disabled={!canExport}
            onClick={() => {
              // `void` perché `onClick` vuole un gestore che non restituisca
              // una promessa: la regola ESLint `no-misused-promises` esiste per
              // i rifiuti che nessuno raccoglierebbe, e qui li raccoglie il
              // `try/catch` dentro `exportCsv`.
              void exportCsv();
            }}
          >
            {exporting ? 'Esportazione…' : 'Esporta CSV'}
          </Button>
        </div>

        {exportError !== null && <p className="text-sm text-red-600">{exportError}</p>}
      </section>

      {invalid !== null ? (
        <p className="text-sm text-red-600">{invalid}</p>
      ) : summary.isPending ? (
        <p className="text-muted-foreground text-sm">Caricamento…</p>
      ) : summary.isError ? (
        <p className="text-sm text-red-600">
          {summary.error instanceof ApiError
            ? summary.error.message
            : 'Errore imprevisto durante la lettura.'}
        </p>
      ) : empty ? (
        <p className="text-muted-foreground text-sm">Nessuna scadenza in questo periodo.</p>
      ) : (
        data !== undefined && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <section className="break-inside-avoid rounded-xl border p-5">
                <h2 className="text-muted-foreground text-sm font-medium">Totale del periodo</h2>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {formatMoney(data.totalCents, currency)}
                </p>
              </section>

              <section className="break-inside-avoid rounded-xl border p-5">
                <h2 className="text-muted-foreground text-sm font-medium">Scadenze contate</h2>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{data.count}</p>
                {/* Saltate e annullate restano fuori dai totali ma dentro il
                    CSV: dirlo qui è ciò che spiega la differenza a chi apre il
                    file e conta le righe. */}
                <p className="text-muted-foreground mt-1 text-xs">
                  Saltate e annullate non contano
                </p>
              </section>

              {data.foreignCount > 0 && (
                <section className="break-inside-avoid rounded-xl border p-5">
                  <h2 className="text-muted-foreground text-sm font-medium">In valuta estera</h2>
                  <p className="mt-2 text-2xl font-semibold tabular-nums">{data.foreignCount}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Convertite al cambio congelato sulla scadenza
                  </p>
                </section>
              )}
            </div>

            <Section title="Andamento mensile">
              <MonthTable months={data.byMonth} currency={currency} />
            </Section>

            <Section title="Per categoria">
              <BucketTable heading="Categoria" buckets={data.byCategory} currency={currency} />
              {/*
                Detto una volta, e mai un «totale 100 %» da nessuna parte: tre
                gruppi da un terzo danno 3333 tre volte, cioè 99,99 %. È
                arrotondamento, e scrivere cento sarebbe una bugia la metà
                delle volte.
              */}
              <p className="text-muted-foreground px-5 py-3 text-xs">
                Le quote non sommano a 100 %: è arrotondamento.
              </p>
            </Section>

            <Section title="Per fornitore">
              <BucketTable heading="Fornitore" buckets={data.byVendor} currency={currency} />
            </Section>

            <Section title="Per cliente">
              <ClientTable buckets={data.byClient} currency={currency} />
              <p className="text-muted-foreground px-5 py-3 text-xs">
                Margine teorico: dalle regole di riaddebito, non da fatture emesse.
              </p>
            </Section>
          </>
        )
      )}
    </div>
  );
}
