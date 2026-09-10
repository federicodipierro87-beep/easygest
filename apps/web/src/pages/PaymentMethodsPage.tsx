import {
  PAYMENT_METHOD_TYPE_LABELS,
  type ArchivedFilter,
  type PaymentMethod,
  type PaymentMethodFormInput,
} from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { DeleteResourceDialog } from '@/components/DeleteResourceDialog';
import { PaymentMethodFormDialog } from '@/components/PaymentMethodFormDialog';
import { ArchivedSelect, ResourcePagination, ResourceToolbar } from '@/components/ResourceControls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { listQueryOptions, useResourceMutations } from '@/lib/resources';

function toInput(method: PaymentMethod): PaymentMethodFormInput {
  const { id, createdAt, updatedAt, expenseCount, ...input } = method;
  return input;
}

/** «03/2027», o un trattino: due campi che valgono solo insieme. */
function formatExpiry(month: number | null, year: number | null): string {
  if (month === null || year === null) return '—';
  return `${String(month).padStart(2, '0')}/${String(year)}`;
}

/**
 * Scaduta rispetto a oggi.
 *
 * Il confine è l'inizio del mese successivo, non l'inizio del mese di
 * scadenza: una carta 03/2027 funziona per tutto marzo, e segnarla in rosso il
 * primo del mese sarebbe un allarme di trenta giorni in anticipo.
 */
function isExpired(month: number | null, year: number | null): boolean {
  if (month === null || year === null) return false;
  return Date.now() >= Date.UTC(year, month, 1);
}

export function PaymentMethodsPage() {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState<ArchivedFilter>('exclude');
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [deleting, setDeleting] = useState<PaymentMethod | null>(null);

  const debouncedQuery = useDebouncedValue(query);
  const list = useQuery(
    listQueryOptions<PaymentMethod>('payment-methods', {
      q: debouncedQuery,
      page,
      archived,
      sort: 'label',
      direction: 'asc',
    }),
  );

  const { create, update, remove } = useResourceMutations<PaymentMethod, PaymentMethodFormInput>(
    'payment-methods',
  );
  const saving = create.isPending || update.isPending;

  function openForm(method: PaymentMethod | null) {
    setEditing(method);
    create.reset();
    update.reset();
    setFormOpen(true);
  }

  async function submit(input: PaymentMethodFormInput): Promise<void> {
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
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Metodi di pagamento</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Nessuna credenziale: solo quel tanto che basta a riconoscere una riga
            sull&rsquo;estratto conto e a sapere quando una carta scade.
          </p>
        </div>
        {data !== undefined && (
          <p className="text-muted-foreground shrink-0 text-sm">
            {data.total === 1 ? '1 metodo' : `${String(data.total)} metodi`}
          </p>
        )}
      </header>

      <ResourceToolbar
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setPage(1);
        }}
        placeholder="Cerca per nome o ultime 4 cifre"
        onCreate={() => {
          openForm(null);
        }}
        createLabel="Nuovo metodo"
      >
        <ArchivedSelect
          value={archived}
          onChange={(value) => {
            setArchived(value);
            setPage(1);
          }}
        />
      </ResourceToolbar>

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
              <TableHead>Nome</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Ultime 4</TableHead>
              <TableHead>Scadenza</TableHead>
              <TableHead className="text-right">Spese</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data === undefined && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                  Caricamento…
                </TableCell>
              </TableRow>
            )}

            {data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                  {debouncedQuery === ''
                    ? 'Nessun metodo di pagamento. Il primo si aggiunge da «Nuovo metodo».'
                    : `Nessun metodo per «${debouncedQuery}».`}
                </TableCell>
              </TableRow>
            )}

            {data?.items.map((method) => {
              const expired = isExpired(method.expiryMonth, method.expiryYear);
              return (
                <TableRow key={method.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {method.label}
                      {!method.isActive && <Badge variant="secondary">Archiviato</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {PAYMENT_METHOD_TYPE_LABELS[method.type]}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {method.last4 === null ? '—' : `•••• ${method.last4}`}
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className={expired ? 'text-red-600' : 'text-muted-foreground'}>
                      {formatExpiry(method.expiryMonth, method.expiryYear)}
                      {expired && ' — scaduta'}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-sm">
                    {method.expenseCount === 0 ? '—' : String(method.expenseCount)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Modifica"
                        onClick={() => {
                          openForm(method);
                        }}
                      >
                        <Pencil aria-hidden className="size-4" />
                        <span className="sr-only">Modifica {method.label}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={method.isActive ? 'Archivia' : 'Ripristina'}
                        onClick={() => {
                          void update.mutateAsync({
                            id: method.id,
                            input: { ...toInput(method), isActive: !method.isActive },
                          });
                        }}
                      >
                        {method.isActive ? (
                          <Archive aria-hidden className="size-4" />
                        ) : (
                          <ArchiveRestore aria-hidden className="size-4" />
                        )}
                        <span className="sr-only">
                          {method.isActive ? 'Archivia' : 'Ripristina'} {method.label}
                        </span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Elimina"
                        onClick={() => {
                          setDeleting(method);
                        }}
                      >
                        <Trash2 aria-hidden className="size-4" />
                        <span className="sr-only">Elimina {method.label}</span>
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
          onPageChange={setPage}
        />
      )}

      <PaymentMethodFormDialog
        key={editing?.id ?? 'nuovo'}
        open={formOpen}
        onOpenChange={setFormOpen}
        method={editing}
        onSubmit={submit}
        pending={saving}
        error={editing === null ? create.error : update.error}
      />

      {/*
        Il campo si chiama `label`, non `name`, e nessun documento punta a un
        metodo di pagamento: la finestra riceve un oggetto costruito qui invece
        della riga intera, e `documentCount` resta assente perché la domanda
        «quanti documenti?» qui non ha senso.
      */}
      <DeleteResourceDialog
        target={
          deleting === null ? null : { name: deleting.label, expenseCount: deleting.expenseCount }
        }
        what="il metodo di pagamento"
        pending={remove.isPending}
        onCancel={() => {
          setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting === null) return;
          void remove.mutateAsync(deleting.id).then(
            () => {
              setDeleting(null);
            },
            () => {
              // La finestra resta aperta: l'API ha rifiutato, e il motivo si
              // rilegge dai conteggi aggiornati dall'invalidazione.
            },
          );
        }}
      />
    </div>
  );
}
