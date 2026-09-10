import {
  EXPENSE_STATUSES,
  EXPENSE_STATUS_LABELS,
  type Expense,
  type ExpenseFormInput,
  type ExpenseStatus,
} from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { DeleteExpenseDialog } from '@/components/DeleteExpenseDialog';
import { ExpenseFormDialog } from '@/components/ExpenseFormDialog';
import type { SelectOption } from '@/components/FormField';
import { FilterSelect, ResourcePagination, ResourceToolbar } from '@/components/ResourceControls';
import { ExpenseStatusBadge } from '@/components/StatusBadges';
import { Badge } from '@/components/ui/badge';
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
import {
  ALL,
  DEFAULT_EXPENSE_FILTERS,
  expenseListQueryOptions,
  useExpenseMutations,
  type ExpenseFilters,
} from '@/lib/expenses';
import { daysUntil, describeDue, describeRecurrence, formatDay, formatMoney } from '@/lib/format';
import { useRelationOptions, type RelationOption } from '@/lib/relations';

/**
 * L'elenco delle spese.
 *
 * Sei filtri invece dei due delle anagrafiche, e non è un vezzo: un'anagrafica
 * si cerca per nome perché il nome lo si conosce, una spesa la si cerca per
 * quello che si sta chiedendo — «quanto pago a questo fornitore», «cosa scade
 * il mese prossimo», «cosa riaddebito a questo cliente» — e nessuna di quelle
 * domande passa dal nome.
 *
 * I filtri non finiscono nell'indirizzo: una vista costruita a fatica non si
 * può ancora mandare a nessuno né ritrovare col tasto «indietro». Vale per
 * tutti gli elenchi dell'applicazione e va fatto per tutti insieme, altrimenti
 * si finisce con due modi diversi di leggere la barra degli indirizzi.
 */

const STATUS_OPTIONS: SelectOption[] = [
  { value: ALL, label: 'Tutti gli stati' },
  ...EXPENSE_STATUSES.map((status) => ({ value: status, label: EXPENSE_STATUS_LABELS[status] })),
];

function relationOptions(options: readonly RelationOption[], everything: string): SelectOption[] {
  return [
    { value: ALL, label: everything },
    ...options.map((option) => ({ value: option.id, label: option.name })),
  ];
}

/** Sotto questa soglia la disdetta è una cosa da fare, non da sapere. */
const DEADLINE_WARNING_DAYS = 45;

interface SortableHeadProps {
  field: ExpenseFilters['sort'];
  label: string;
  filters: ExpenseFilters;
  onSort: (field: ExpenseFilters['sort']) => void;
  className?: string;
}

function SortableHead({ field, label, filters, onSort, className }: SortableHeadProps) {
  const active = filters.sort === field;
  return (
    <TableHead className={className}>
      <button
        type="button"
        className="hover:text-foreground inline-flex items-center gap-1"
        onClick={() => {
          onSort(field);
        }}
      >
        {label}
        {active &&
          (filters.direction === 'asc' ? (
            <ArrowUp aria-hidden className="size-3" />
          ) : (
            <ArrowDown aria-hidden className="size-3" />
          ))}
      </button>
    </TableHead>
  );
}

export function ExpensesPage() {
  const [filters, setFilters] = useState<ExpenseFilters>(DEFAULT_EXPENSE_FILTERS);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);

  const relations = useRelationOptions();
  const debouncedQuery = useDebouncedValue(filters.q);
  const list = useQuery(expenseListQueryOptions({ ...filters, q: debouncedQuery }));

  const { create, update, remove } = useExpenseMutations();
  const saving = create.isPending || update.isPending;

  /**
   * Cambiare un filtro riporta alla prima pagina.
   *
   * Restare sulla terza di un elenco che ora ne ha una mostrerebbe una tabella
   * vuota indistinguibile da «nessun risultato», e la risposta giusta —
   * «torna indietro di due pagine» — non la suggerisce nulla a schermo.
   */
  function setFilter<K extends keyof ExpenseFilters>(key: K, value: ExpenseFilters[K]) {
    setFilters((previous) => ({ ...previous, [key]: value, page: 1 }));
  }

  function sortBy(field: ExpenseFilters['sort']) {
    setFilters((previous) => ({
      ...previous,
      sort: field,
      // Ripremere sulla stessa colonna gira il verso; cambiare colonna riparte
      // dal crescente, che su un nome è l'ordine che ci si aspetta.
      direction: previous.sort === field && previous.direction === 'asc' ? 'desc' : 'asc',
      page: 1,
    }));
  }

  function openForm(expense: Expense | null) {
    setEditing(expense);
    create.reset();
    update.reset();
    setFormOpen(true);
  }

  async function submit(input: ExpenseFormInput): Promise<void> {
    if (editing === null) {
      await create.mutateAsync(input);
    } else {
      await update.mutateAsync({ id: editing.id, input });
    }
    setFormOpen(false);
  }

  const data = list.data;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Spese</h1>
        {data !== undefined && (
          <p className="text-muted-foreground text-sm">
            {data.total === 1 ? '1 spesa' : `${String(data.total)} spese`}
          </p>
        )}
      </header>

      <div className="flex flex-col gap-3">
        <ResourceToolbar
          query={filters.q}
          onQueryChange={(value) => {
            setFilter('q', value);
          }}
          placeholder="Cerca per nome o descrizione"
          onCreate={() => {
            openForm(null);
          }}
          createLabel="Nuova spesa"
        >
          <FilterSelect
            label="Stato"
            value={filters.status}
            onChange={(value) => {
              setFilter('status', value as ExpenseStatus | typeof ALL);
            }}
            options={STATUS_OPTIONS}
          />
        </ResourceToolbar>

        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Fornitore"
            value={filters.vendorId}
            onChange={(value) => {
              setFilter('vendorId', value);
            }}
            options={relationOptions(relations.vendors, 'Tutti i fornitori')}
            className="w-52"
          />
          <FilterSelect
            label="Categoria"
            value={filters.categoryId}
            onChange={(value) => {
              setFilter('categoryId', value);
            }}
            options={relationOptions(relations.categories, 'Tutte le categorie')}
            className="w-52"
          />
          <FilterSelect
            label="Cliente"
            value={filters.clientId}
            onChange={(value) => {
              setFilter('clientId', value);
            }}
            options={relationOptions(relations.clients, 'Tutti i clienti')}
            className="w-52"
          />

          {/*
            La finestra filtra sulla prossima scadenza, non sulla data di
            inizio: «cosa mi arriva a maggio» è la domanda, e una spesa
            cominciata nel 2019 ne fa parte.
          */}
          <div className="grid gap-1.5">
            <Label htmlFor="expenses-due-from" className="text-muted-foreground text-xs">
              Scadenza da
            </Label>
            <Input
              id="expenses-due-from"
              type="date"
              className="w-40"
              value={filters.dueFrom}
              onChange={(event) => {
                setFilter('dueFrom', event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="expenses-due-to" className="text-muted-foreground text-xs">
              a
            </Label>
            <Input
              id="expenses-due-to"
              type="date"
              className="w-40"
              value={filters.dueTo}
              onChange={(event) => {
                setFilter('dueTo', event.target.value);
              }}
            />
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilters(DEFAULT_EXPENSE_FILTERS);
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

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead field="name" label="Nome" filters={filters} onSort={sortBy} />
              <TableHead>Categoria</TableHead>
              <SortableHead
                field="grossCents"
                label="Importo"
                filters={filters}
                onSort={sortBy}
                className="text-right"
              />
              <TableHead>Ricorrenza</TableHead>
              <TableHead>Prossima scadenza</TableHead>
              <TableHead>Stato</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data === undefined && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                  Caricamento…
                </TableCell>
              </TableRow>
            )}

            {data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                  {debouncedQuery === ''
                    ? 'Nessuna spesa con questi filtri. La prima si aggiunge da «Nuova spesa».'
                    : `Nessuna spesa per «${debouncedQuery}».`}
                </TableCell>
              </TableRow>
            )}

            {data?.items.map((expense) => {
              const deadline = expense.nextCancellationDeadline;
              const toDeadline = deadline === null ? null : daysUntil(deadline);
              const urgent = toDeadline !== null && toDeadline <= DEADLINE_WARNING_DAYS;

              return (
                <TableRow key={expense.id}>
                  <TableCell className="font-medium">
                    <Link to={`/spese/${expense.id}`} className="hover:underline">
                      {expense.name}
                    </Link>
                    {expense.vendorName !== null && (
                      <p className="text-muted-foreground text-xs">{expense.vendorName}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {expense.categoryName ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(expense.grossCents, expense.currency)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {describeRecurrence(expense.recurrenceUnit, expense.recurrenceInterval)}
                  </TableCell>
                  <TableCell>
                    {expense.nextDueDate === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        <span className="tabular-nums">{formatDay(expense.nextDueDate)}</span>
                        <p className="text-muted-foreground text-xs">
                          {describeDue(expense.nextDueDate)}
                        </p>
                      </>
                    )}
                    {/*
                      L'ultimo giorno utile per disdire si mostra solo quando è
                      vicino: su una spesa che si rinnova fra otto mesi sarebbe
                      una data in più da leggere ogni volta, e il giorno in cui
                      conta si perderebbe fra le altre.
                    */}
                    {urgent && (
                      <Badge variant="destructive" className="mt-1">
                        Disdetta entro il {formatDay(deadline)}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <ExpenseStatusBadge status={expense.status} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Modifica"
                        onClick={() => {
                          openForm(expense);
                        }}
                      >
                        <Pencil aria-hidden className="size-4" />
                        <span className="sr-only">Modifica {expense.name}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Elimina"
                        onClick={() => {
                          remove.reset();
                          setDeleting(expense);
                        }}
                      >
                        <Trash2 aria-hidden className="size-4" />
                        <span className="sr-only">Elimina {expense.name}</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

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

      {/*
        La `key` rigenera lo stato del modulo a ogni apertura: senza,
        modificare una spesa e poi aprirne un'altra mostrerebbe i campi della
        prima.
      */}
      <ExpenseFormDialog
        key={editing?.id ?? 'nuova'}
        open={formOpen}
        onOpenChange={setFormOpen}
        expense={editing}
        onSubmit={submit}
        pending={saving}
        error={editing === null ? create.error : update.error}
      />

      <DeleteExpenseDialog
        target={deleting}
        pending={remove.isPending}
        error={remove.error}
        onCancel={() => {
          setDeleting(null);
          remove.reset();
        }}
        onConfirm={() => {
          if (deleting === null) return;
          void remove.mutateAsync(deleting.id).then(
            () => {
              setDeleting(null);
            },
            () => {
              // Il rifiuto lo legge la finestra da `remove.error`, e da lì
              // cambia contenuto: qui non c'è niente da fare se non restare.
            },
          );
        }}
      />
    </div>
  );
}
