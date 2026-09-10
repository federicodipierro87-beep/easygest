import type { ArchivedFilter, Client, ClientInput, Paginated } from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { ClientFormDialog } from '@/components/ClientFormDialog';
import { DeleteResourceDialog } from '@/components/DeleteResourceDialog';
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

/**
 * L'anagrafica come la si rimanda all'API.
 *
 * Serve per archiviare e ripescare: sono un `PUT` come tutti gli altri, e il
 * `PUT` sostituisce il record per intero, quindi bisogna rispedire anche i
 * campi che non si stanno cambiando. Ometterli li azzererebbe.
 */
function toInput(client: Client): ClientInput {
  const { id, createdAt, updatedAt, expenseCount, documentCount, ...input } = client;
  return input;
}

export function ClientsPage() {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState<ArchivedFilter>('exclude');
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState<Client | null>(null);

  const debouncedQuery = useDebouncedValue(query);
  const list = useQuery(
    listQueryOptions<Client>('clients', {
      q: debouncedQuery,
      page,
      archived,
      sort: 'name',
      direction: 'asc',
    }),
  );

  const { create, update, remove } = useResourceMutations<Client, ClientInput>('clients');
  const saving = create.isPending || update.isPending;

  function openForm(client: Client | null) {
    setEditing(client);
    // Gli errori del salvataggio precedente non riguardano questo modulo:
    // riaprirlo con un campo già rosso sarebbe un rimprovero per qualcosa che
    // non si è ancora fatto.
    create.reset();
    update.reset();
    setFormOpen(true);
  }

  async function submit(input: ClientInput): Promise<void> {
    if (editing === null) {
      await create.mutateAsync(input);
    } else {
      await update.mutateAsync({ id: editing.id, input });
    }
    setFormOpen(false);
  }

  const data: Paginated<Client> | undefined = list.data;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Clienti</h1>
        {data !== undefined && (
          <p className="text-muted-foreground text-sm">
            {data.total === 1 ? '1 cliente' : `${String(data.total)} clienti`}
          </p>
        )}
      </header>

      <ResourceToolbar
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          // Cambiando i filtri si torna alla prima pagina: restare sulla terza
          // di un elenco che ora ne ha una mostrerebbe una tabella vuota che
          // sembra un «nessun risultato».
          setPage(1);
        }}
        placeholder="Cerca per nome, partita IVA, codice fiscale, email o città"
        onCreate={() => {
          openForm(null);
        }}
        createLabel="Nuovo cliente"
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
              <TableHead>Partita IVA</TableHead>
              <TableHead>Città</TableHead>
              <TableHead>Contatti</TableHead>
              <TableHead className="text-right">Collegamenti</TableHead>
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
                    ? 'Nessun cliente. Il primo si aggiunge da «Nuovo cliente».'
                    : `Nessun cliente per «${debouncedQuery}».`}
                </TableCell>
              </TableRow>
            )}

            {data?.items.map((client) => (
              <TableRow key={client.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {client.name}
                    {!client.isActive && <Badge variant="secondary">Archiviato</Badge>}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {client.vatNumber ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">{client.city ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{client.email ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground text-right text-sm">
                  {client.expenseCount + client.documentCount === 0
                    ? '—'
                    : `${String(client.expenseCount)} sp. · ${String(client.documentCount)} doc.`}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Modifica"
                      onClick={() => {
                        openForm(client);
                      }}
                    >
                      <Pencil aria-hidden className="size-4" />
                      <span className="sr-only">Modifica {client.name}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title={client.isActive ? 'Archivia' : 'Ripristina'}
                      onClick={() => {
                        void update.mutateAsync({
                          id: client.id,
                          input: { ...toInput(client), isActive: !client.isActive },
                        });
                      }}
                    >
                      {client.isActive ? (
                        <Archive aria-hidden className="size-4" />
                      ) : (
                        <ArchiveRestore aria-hidden className="size-4" />
                      )}
                      <span className="sr-only">
                        {client.isActive ? 'Archivia' : 'Ripristina'} {client.name}
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Elimina"
                      onClick={() => {
                        setDeleting(client);
                      }}
                    >
                      <Trash2 aria-hidden className="size-4" />
                      <span className="sr-only">Elimina {client.name}</span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
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

      {/*
        La `key` rigenera lo stato del modulo a ogni apertura: senza,
        modificare un cliente e poi aprirne un altro mostrerebbe i campi del
        primo.
      */}
      <ClientFormDialog
        key={editing?.id ?? 'nuovo'}
        open={formOpen}
        onOpenChange={setFormOpen}
        client={editing}
        onSubmit={submit}
        pending={saving}
        error={editing === null ? create.error : update.error}
      />

      <DeleteResourceDialog
        target={deleting}
        what="il cliente"
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
              // L'API ha rifiutato: la finestra resta aperta, e i conteggi che
              // mostra vengono riletti dall'invalidazione. Il caso normale è
              // che nel frattempo qualcosa si sia agganciato al cliente.
            },
          );
        }}
      />
    </div>
  );
}
