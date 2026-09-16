import {
  OCCURRENCE_STATUSES,
  OCCURRENCE_STATUS_LABELS,
  addMonths,
  formatIsoDate,
  parseIsoDate,
  type ExpenseOccurrence,
  type OccurrencePatch,
  type OccurrenceStatus,
} from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'react-router';

import type { SelectOption } from '@/components/FormField';
import { OccurrenceEditDialog } from '@/components/OccurrenceEditDialog';
import { OccurrenceTable } from '@/components/OccurrenceTable';
import { FilterSelect, ResourcePagination, ResourceToolbar } from '@/components/ResourceControls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { ApiError } from '@/lib/api';
import {
  ALL,
  occurrenceListQueryOptions,
  useOccurrenceMutations,
  type OccurrenceFilters,
} from '@/lib/expenses';
import { formatMoney, isoPlusDays, todayIso } from '@/lib/format';
import type { DuePreset } from '@/pages/DashboardPage';

/**
 * Tutte le scadenze, di tutte le spese.
 *
 * È la domanda «cosa devo pagare», che il dettaglio di una spesa non risponde:
 * lì si vede una cosa per volta, e chi paga guarda il mese, non il fornitore.
 *
 * La finestra iniziale parte da **ieri all'indietro senza limite** e arriva a
 * due mesi: `to` è pieno, `from` è vuoto di proposito. Uno scaduto e non
 * pagato è la riga più importante dell'elenco, e nascondere il passato la
 * toglierebbe proprio dalla pagina che esiste per trovarla.
 *
 * Nessun pulsante «Nuova»: le occorrenze non si creano, le genera il motore
 * dalla spesa.
 */

/** Quanto avanti guarda l'apertura. Due mesi coprono il rinnovo trimestrale. */
const WINDOW_DAYS = 60;

/**
 * Non una costante: «oggi + 60» va calcolato quando si apre la pagina.
 *
 * Un modulo valutato una volta al caricamento del bundle terrebbe la finestra
 * di quel giorno, e una scheda lasciata aperta una settimana mostrerebbe una
 * data di fine di sette giorni fa.
 */
function defaultDueFilters(): OccurrenceFilters {
  return {
    q: '',
    page: 1,
    expenseId: ALL,
    status: 'PLANNED',
    from: '',
    to: isoPlusDays(todayIso(), WINDOW_DAYS),
    unconfirmed: false,
    sort: 'dueDate',
    direction: 'asc',
  };
}

/**
 * Quanto avanti guarda il riquadro «In arrivo» della dashboard.
 *
 * È la copia di `UPCOMING_DAYS` di `services/agenda.ts`, che sta nell'API e da
 * qui non si può importare. La copia è dichiarata invece che nascosta: se le
 * due divergono, il preset porta a un elenco che non contiene le righe appena
 * viste nel riquadro, ed è il tipo di scollamento che non dà errore da nessuna
 * parte. Prima di spostarla in `shared` conviene aspettare il terzo uso.
 */
const UPCOMING_DAYS = 7;

interface DueWindow {
  from: string;
  to: string;
}

function nextDays(days: number): DueWindow {
  const today = todayIso();
  return { from: today, to: isoPlusDays(today, days) };
}

function thisMonth(): DueWindow {
  const today = todayIso();
  const from = `${today.slice(0, 7)}-01`;
  const first = parseIsoDate(from);
  // Dal primo del mese, un mese avanti è sempre il primo del successivo:
  // `addMonths` tronca il giorno solo quando non esiste, e il primo esiste
  // ovunque. Da lì, un giorno indietro è l'ultimo di questo mese.
  const to = first === null ? today : isoPlusDays(formatIsoDate(addMonths(first, 1)), -1);
  return { from, to };
}

/**
 * «Da confermare» è una voce dello stato, non una casella accanto.
 *
 * Sul server `unconfirmed` sovrascrive `status` — la riga diventa comunque
 * `PAID` con `confirmedAt` nullo — quindi una casella indipendente lascerebbe
 * comporre «Prevista + solo da confermare» e restituirebbe delle pagate. Come
 * quinta scelta della stessa tendina la combinazione impossibile non si può
 * nemmeno esprimere.
 */
const UNCONFIRMED = 'unconfirmed';

const STATUS_OPTIONS: SelectOption[] = [
  { value: ALL, label: 'Tutti gli stati' },
  ...OCCURRENCE_STATUSES.map((status) => ({
    value: status,
    label: OCCURRENCE_STATUS_LABELS[status],
  })),
  { value: UNCONFIRMED, label: 'Solo da confermare' },
];

/**
 * I filtri con cui si arriva da un riquadro dell'agenda.
 *
 * Ogni preset ricalca la `where` della sezione corrispondente in
 * `services/agenda.ts:collectAgenda` (210-220): «da confermare» non ha limiti
 * di data — una pagata non confermata di sei mesi fa va vista — mentre «in
 * ritardo» e «in arrivo» sono le due metà della finestra intorno a oggi.
 *
 * Il preset sconosciuto ricade sul filtro di sempre invece di lanciare: arriva
 * dallo stato della navigazione, che è `unknown` e può contenere qualunque cosa
 * — anche quella lasciata lì da una versione precedente dell'applicazione.
 */
function presetFilters(state: unknown): OccurrenceFilters {
  const base = defaultDueFilters();
  const preset = (state as { preset?: unknown } | null)?.preset;
  const today = todayIso();

  switch (preset) {
    case 'unconfirmed' satisfies DuePreset:
      return { ...base, status: ALL, unconfirmed: true, from: '', to: '' };
    case 'overdue' satisfies DuePreset:
      return { ...base, status: 'PLANNED', from: '', to: isoPlusDays(today, -1) };
    case 'upcoming' satisfies DuePreset:
      return { ...base, status: 'PLANNED', from: today, to: isoPlusDays(today, UPCOMING_DAYS) };
    default:
      return base;
  }
}

export function DueDatesPage() {
  /**
   * Il preset si legge una volta sola, all'apertura.
   *
   * Passandolo all'inizializzatore di `useState` invece che a un `useEffect`
   * si evita il lampeggio dell'elenco di default prima di quello filtrato, e
   * soprattutto si evita che il preset torni a imporsi ogni volta che l'utente
   * tocca un filtro. Il prezzo è che ricaricando la pagina lo stato della
   * navigazione svanisce e si torna al filtro di sempre: è il debito dichiarato
   * di non avere i filtri nell'URL.
   */
  const location = useLocation();
  const [filters, setFilters] = useState<OccurrenceFilters>(() => presetFilters(location.state));
  const [correcting, setCorrecting] = useState<ExpenseOccurrence | null>(null);

  const debouncedQuery = useDebouncedValue(filters.q);
  const list = useQuery(occurrenceListQueryOptions({ ...filters, q: debouncedQuery }));

  const { patch } = useOccurrenceMutations();

  function setFilter<K extends keyof OccurrenceFilters>(key: K, value: OccurrenceFilters[K]) {
    setFilters((previous) => ({ ...previous, [key]: value, page: 1 }));
  }

  function setStatus(value: string) {
    setFilters((previous) => ({
      ...previous,
      status: value === UNCONFIRMED ? ALL : (value as OccurrenceStatus | typeof ALL),
      unconfirmed: value === UNCONFIRMED,
      page: 1,
    }));
  }

  function setWindow(window: DueWindow) {
    setFilters((previous) => ({ ...previous, ...window, page: 1 }));
  }

  function correct(id: string, body: OccurrencePatch) {
    patch.mutate({ id, patch: body });
  }

  const data = list.data;

  /**
   * Il totale è quello della pagina, e lo dice.
   *
   * Sommare tutte le scadenze filtrate vorrebbe dire un endpoint che le somma,
   * perché il client ha in mano venti righe su duecento. Un numero senza la
   * riserva sarebbe peggio di nessun numero: sembrerebbe il conto del mese.
   */
  const pageTotal = data?.items.reduce((sum, item) => sum + item.baseGrossCents, 0) ?? 0;
  const partial = data !== undefined && data.totalPages > 1;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Scadenze</h1>
        {data !== undefined && (
          <p className="text-muted-foreground text-sm">
            {partial ? 'In questa pagina: ' : 'Totale: '}
            <span className="text-foreground font-medium tabular-nums">
              {formatMoney(pageTotal)}
            </span>
          </p>
        )}
      </header>

      <div className="flex flex-col gap-3">
        <ResourceToolbar
          query={filters.q}
          onQueryChange={(value) => {
            setFilter('q', value);
          }}
          placeholder="Cerca per nome della spesa"
        >
          <FilterSelect
            label="Stato"
            value={filters.unconfirmed ? UNCONFIRMED : filters.status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
            className="w-48"
          />
        </ResourceToolbar>

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="due-from" className="text-muted-foreground text-xs">
              Da
            </Label>
            <Input
              id="due-from"
              type="date"
              className="w-40"
              value={filters.from}
              onChange={(event) => {
                setFilter('from', event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="due-to" className="text-muted-foreground text-xs">
              a
            </Label>
            <Input
              id="due-to"
              type="date"
              className="w-40"
              value={filters.to}
              onChange={(event) => {
                setFilter('to', event.target.value);
              }}
            />
          </div>

          {/*
            Le tre finestre che si chiedono davvero. Scriverle a mano vuol dire
            due caselle di data per una domanda che ha una risposta sola.
          */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setWindow(nextDays(30));
            }}
          >
            Prossimi 30 giorni
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setWindow(thisMonth());
            }}
          >
            Questo mese
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setWindow({ from: '', to: '' });
            }}
          >
            Tutto
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilters(defaultDueFilters());
            }}
          >
            Azzera i filtri
          </Button>
        </div>
      </div>

      {list.isError && (
        <p className="text-sm text-red-600">
          {list.error instanceof ApiError
            ? list.error.message
            : 'Errore imprevisto durante la lettura.'}
        </p>
      )}

      <OccurrenceTable
        items={data?.items}
        showExpense
        onEdit={(occurrence) => {
          patch.reset();
          setCorrecting(occurrence);
        }}
        onPatch={correct}
        pendingId={patch.isPending ? (patch.variables?.id ?? null) : null}
        emptyMessage="Nessuna scadenza in questa finestra. Prova ad allargarla con «Tutto»."
      />

      {data !== undefined && (
        <ResourcePagination
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          onPageChange={(page) => {
            setFilters((previous) => ({ ...previous, page }));
          }}
        />
      )}

      <OccurrenceEditDialog
        occurrence={correcting}
        onClose={() => {
          setCorrecting(null);
          patch.reset();
        }}
        onSubmit={(body) =>
          patch.mutateAsync({ id: correcting?.id ?? '', patch: body }).then(
            () => {
              setCorrecting(null);
            },
            () => {
              // Il messaggio lo legge la finestra da `patch.error`: qui non
              // c'è niente da fare se non restare aperti.
            },
          )
        }
        pending={patch.isPending}
        error={patch.error}
      />
    </div>
  );
}
