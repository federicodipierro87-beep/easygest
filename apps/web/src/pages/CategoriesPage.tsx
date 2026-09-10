import type { ArchivedFilter, Category, CategoryInput, CategoryScope } from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { CategoryFormDialog } from '@/components/CategoryFormDialog';
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
import { CATEGORY_ICON_COMPONENTS } from '@/lib/category-icons';
import { listQueryOptions, useResourceMutations } from '@/lib/resources';

/**
 * La categoria come la si rimanda all'API.
 *
 * `isSystem` e `sortOrder` non sono nell'input e non ci finiscono: li decide il
 * server. Toglierli qui non è una precauzione estetica — lo schema condiviso è
 * `strictObject`, quindi lasciarli dentro farebbe fallire ogni archiviazione
 * con un errore di validazione.
 */
function toInput(category: Category): CategoryInput {
  const { id, createdAt, updatedAt, expenseCount, documentCount, isSystem, sortOrder, ...input } =
    category;
  return input;
}

const SCOPE_LABELS: Record<CategoryScope, string> = {
  BOTH: 'Spese e documenti',
  EXPENSE: 'Spese',
  DOCUMENT: 'Documenti',
};

export function CategoriesPage() {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState<ArchivedFilter>('exclude');
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);

  const debouncedQuery = useDebouncedValue(query);
  const list = useQuery(
    listQueryOptions<Category>('categories', {
      q: debouncedQuery,
      page,
      archived,
      // L'ordine è quello manuale, non l'alfabetico: il seed numera le
      // categorie per frequenza d'uso, ed è l'ordine in cui compariranno nei
      // menù a tendina delle spese.
      sort: 'sortOrder',
      direction: 'asc',
    }),
  );

  const { create, update, remove } = useResourceMutations<Category, CategoryInput>('categories');
  const saving = create.isPending || update.isPending;

  function openForm(category: Category | null) {
    setEditing(category);
    create.reset();
    update.reset();
    setFormOpen(true);
  }

  async function submit(input: CategoryInput): Promise<void> {
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
          <h1 className="text-xl font-semibold tracking-tight">Categorie</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Raggruppano spese e documenti. Quelle predefinite si possono rinominare e archiviare,
            non eliminare.
          </p>
        </div>
        {data !== undefined && (
          <p className="text-muted-foreground shrink-0 text-sm">
            {data.total === 1 ? '1 categoria' : `${String(data.total)} categorie`}
          </p>
        )}
      </header>

      <ResourceToolbar
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setPage(1);
        }}
        placeholder="Cerca per nome"
        onCreate={() => {
          openForm(null);
        }}
        createLabel="Nuova categoria"
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
              <TableHead>Ambito</TableHead>
              <TableHead className="text-right">Collegamenti</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data === undefined && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground py-10 text-center">
                  Caricamento…
                </TableCell>
              </TableRow>
            )}

            {data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground py-10 text-center">
                  {debouncedQuery === ''
                    ? 'Nessuna categoria. La prima si aggiunge da «Nuova categoria».'
                    : `Nessuna categoria per «${debouncedQuery}».`}
                </TableCell>
              </TableRow>
            )}

            {data?.items.map((category) => {
              const Icon = category.icon === null ? null : CATEGORY_ICON_COMPONENTS[category.icon];
              return (
                <TableRow key={category.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {/*
                        Il colore è un quadratino accanto al nome e non lo
                        sfondo della riga: una tabella con undici righe di
                        undici colori diversi è illeggibile, e il colore serve
                        a ritrovare la categoria, non a decorare l'elenco.
                      */}
                      <span
                        aria-hidden
                        className="size-3 shrink-0 rounded-full border"
                        style={
                          category.color === null ? undefined : { backgroundColor: category.color }
                        }
                      />
                      {Icon !== null && (
                        <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                      )}
                      {category.name}
                      {category.isSystem && <Badge variant="outline">Predefinita</Badge>}
                      {!category.isActive && <Badge variant="secondary">Archiviata</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {SCOPE_LABELS[category.scope]}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-sm">
                    {category.expenseCount + category.documentCount === 0
                      ? '—'
                      : `${String(category.expenseCount)} sp. · ${String(category.documentCount)} doc.`}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Modifica"
                        onClick={() => {
                          openForm(category);
                        }}
                      >
                        <Pencil aria-hidden className="size-4" />
                        <span className="sr-only">Modifica {category.name}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={category.isActive ? 'Archivia' : 'Ripristina'}
                        onClick={() => {
                          void update.mutateAsync({
                            id: category.id,
                            input: { ...toInput(category), isActive: !category.isActive },
                          });
                        }}
                      >
                        {category.isActive ? (
                          <Archive aria-hidden className="size-4" />
                        ) : (
                          <ArchiveRestore aria-hidden className="size-4" />
                        )}
                        <span className="sr-only">
                          {category.isActive ? 'Archivia' : 'Ripristina'} {category.name}
                        </span>
                      </Button>
                      {/*
                        Il pulsante c'è anche sulle predefinite, e non è
                        disattivato: apre la finestra che spiega perché non si
                        possono eliminare. Un pulsante spento non dice niente,
                        e la domanda «perché no?» resterebbe senza risposta.
                      */}
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Elimina"
                        onClick={() => {
                          setDeleting(category);
                        }}
                      >
                        <Trash2 aria-hidden className="size-4" />
                        <span className="sr-only">Elimina {category.name}</span>
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

      <CategoryFormDialog
        key={editing?.id ?? 'nuova'}
        open={formOpen}
        onOpenChange={setFormOpen}
        category={editing}
        onSubmit={submit}
        pending={saving}
        error={editing === null ? create.error : update.error}
      />

      <DeleteResourceDialog
        target={deleting}
        what="la categoria"
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
              // La finestra resta aperta: l'API ha rifiutato, e i conteggi che
              // mostra vengono riletti dall'invalidazione.
            },
          );
        }}
      />
    </div>
  );
}
