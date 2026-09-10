import type { ArchivedFilter, Paginated, Vendor, VendorInput } from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { DeleteResourceDialog } from '@/components/DeleteResourceDialog';
import { ArchivedSelect, ResourcePagination, ResourceToolbar } from '@/components/ResourceControls';
import { VendorFormDialog } from '@/components/VendorFormDialog';
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

function toInput(vendor: Vendor): VendorInput {
  const { id, createdAt, updatedAt, expenseCount, documentCount, ...input } = vendor;
  return input;
}

/** L'indirizzo senza schema né barra finale: in tabella conta il dominio. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function VendorsPage() {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState<ArchivedFilter>('exclude');
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [deleting, setDeleting] = useState<Vendor | null>(null);

  const debouncedQuery = useDebouncedValue(query);
  const list = useQuery(
    listQueryOptions<Vendor>('vendors', {
      q: debouncedQuery,
      page,
      archived,
      sort: 'name',
      direction: 'asc',
    }),
  );

  const { create, update, remove } = useResourceMutations<Vendor, VendorInput>('vendors');
  const saving = create.isPending || update.isPending;

  function openForm(vendor: Vendor | null) {
    setEditing(vendor);
    create.reset();
    update.reset();
    setFormOpen(true);
  }

  async function submit(input: VendorInput): Promise<void> {
    if (editing === null) {
      await create.mutateAsync(input);
    } else {
      await update.mutateAsync({ id: editing.id, input });
    }
    setFormOpen(false);
  }

  const data: Paginated<Vendor> | undefined = list.data;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Fornitori</h1>
        {data !== undefined && (
          <p className="text-muted-foreground text-sm">
            {data.total === 1 ? '1 fornitore' : `${String(data.total)} fornitori`}
          </p>
        )}
      </header>

      <ResourceToolbar
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setPage(1);
        }}
        placeholder="Cerca per nome, numero cliente, partita IVA o sito"
        onCreate={() => {
          openForm(null);
        }}
        createLabel="Nuovo fornitore"
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
              <TableHead>Sito</TableHead>
              <TableHead>Numero cliente</TableHead>
              <TableHead>Pannello</TableHead>
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
                    ? 'Nessun fornitore. Il primo si aggiunge da «Nuovo fornitore».'
                    : `Nessun fornitore per «${debouncedQuery}».`}
                </TableCell>
              </TableRow>
            )}

            {data?.items.map((vendor) => (
              <TableRow key={vendor.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {vendor.name}
                    {!vendor.isActive && <Badge variant="secondary">Archiviato</Badge>}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {vendor.website === null ? (
                    '—'
                  ) : (
                    /**
                     * `rel="noreferrer"`: senza, la pagina aperta riceve
                     * l'indirizzo da cui arriva, e `noopener` le impedisce di
                     * manovrare la scheda che l'ha aperta. Lo schema è
                     * garantito http o https dallo schema condiviso, che è il
                     * motivo per cui questo collegamento si può costruire
                     * senza controllare altro.
                     */
                    <a
                      href={vendor.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-foreground inline-flex items-center gap-1 underline-offset-4 hover:underline"
                    >
                      {shortUrl(vendor.website)}
                    </a>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {vendor.accountRef ?? '—'}
                </TableCell>
                <TableCell>
                  {vendor.portalUrl === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <a
                      href={vendor.portalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
                    >
                      Apri
                      <ExternalLink aria-hidden className="size-3.5" />
                    </a>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-sm">
                  {vendor.expenseCount + vendor.documentCount === 0
                    ? '—'
                    : `${String(vendor.expenseCount)} sp. · ${String(vendor.documentCount)} doc.`}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Modifica"
                      onClick={() => {
                        openForm(vendor);
                      }}
                    >
                      <Pencil aria-hidden className="size-4" />
                      <span className="sr-only">Modifica {vendor.name}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title={vendor.isActive ? 'Archivia' : 'Ripristina'}
                      onClick={() => {
                        void update.mutateAsync({
                          id: vendor.id,
                          input: { ...toInput(vendor), isActive: !vendor.isActive },
                        });
                      }}
                    >
                      {vendor.isActive ? (
                        <Archive aria-hidden className="size-4" />
                      ) : (
                        <ArchiveRestore aria-hidden className="size-4" />
                      )}
                      <span className="sr-only">
                        {vendor.isActive ? 'Archivia' : 'Ripristina'} {vendor.name}
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Elimina"
                      onClick={() => {
                        setDeleting(vendor);
                      }}
                    >
                      <Trash2 aria-hidden className="size-4" />
                      <span className="sr-only">Elimina {vendor.name}</span>
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

      <VendorFormDialog
        key={editing?.id ?? 'nuovo'}
        open={formOpen}
        onOpenChange={setFormOpen}
        vendor={editing}
        onSubmit={submit}
        pending={saving}
        error={editing === null ? create.error : update.error}
      />

      <DeleteResourceDialog
        target={deleting}
        what="il fornitore"
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
