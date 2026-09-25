import {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  type Document,
  type DocumentFormInput,
  type DocumentKind,
} from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { DocumentFormDialog } from '@/components/DocumentFormDialog';
import type { SelectOption } from '@/components/FormField';
import { FilterSelect, ResourcePagination, ResourceToolbar } from '@/components/ResourceControls';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
  DEFAULT_DOCUMENT_FILTERS,
  type DocumentFilters,
  type PendingUpload,
  documentListQueryOptions,
  formatFileSize,
  openDocument,
  useDocumentMutations,
} from '@/lib/documents';
import { ALL } from '@/lib/expenses';
import { formatDay, formatMoney } from '@/lib/format';
import { useRelationOptions, type RelationOption } from '@/lib/relations';

/**
 * L'archivio dei documenti.
 *
 * Si carica in due modi, e il secondo è quello che conta: trascinando un file
 * **ovunque** sulla pagina. Un PDF appena scaricato da un'email sta già sul
 * desktop, e andare a cercare un bottone per poi ritrovarlo in una finestra di
 * scelta dei file è il passo che fa rimandare l'archiviazione a «dopo».
 */

const KIND_OPTIONS: SelectOption[] = [
  { value: ALL, label: 'Tutti i tipi' },
  ...DOCUMENT_KINDS.map((kind) => ({ value: kind, label: DOCUMENT_KIND_LABELS[kind] })),
];

function relationOptions(options: readonly RelationOption[], everything: string): SelectOption[] {
  return [
    { value: ALL, label: everything },
    ...options.map((option) => ({ value: option.id, label: option.name })),
  ];
}

interface SortableHeadProps {
  field: DocumentFilters['sort'];
  label: string;
  filters: DocumentFilters;
  onSort: (field: DocumentFilters['sort']) => void;
  className?: string;
}

function SortableHead({ field, label, filters, onSort, className }: SortableHeadProps) {
  // Con una ricerca l'ordine è la pertinenza, e la freccia mentirebbe.
  const active = filters.sort === field && filters.q === '';
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

/** Con chi è il documento: il cliente, il fornitore, o tutti e due. */
function counterpart(document: Document): string {
  const names = [document.clientName, document.vendorName].filter((name) => name !== null);
  return names.length === 0 ? '—' : names.join(' · ');
}

export function DocumentsPage() {
  const [filters, setFilters] = useState<DocumentFilters>(DEFAULT_DOCUMENT_FILTERS);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Document | null>(null);
  const [dropped, setDropped] = useState<File | null>(null);
  const [deleting, setDeleting] = useState<Document | null>(null);
  const [dragging, setDragging] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // Cambia a ogni apertura: la `key` del modulo, perché riparta da capo anche
  // quando si ricarica due volte di fila senza modificare niente in mezzo.
  const [formSession, setFormSession] = useState(0);

  const relations = useRelationOptions();
  const debouncedQuery = useDebouncedValue(filters.q);
  const list = useQuery(documentListQueryOptions({ ...filters, q: debouncedQuery }));
  const { create, update, remove } = useDocumentMutations();

  function setFilter<K extends keyof DocumentFilters>(key: K, value: DocumentFilters[K]) {
    setFilters((previous) => ({ ...previous, [key]: value, page: 1 }));
  }

  function sortBy(field: DocumentFilters['sort']) {
    setFilters((previous) => ({
      ...previous,
      sort: field,
      // Le date partono dalla più recente, il titolo dalla A.
      direction:
        previous.sort === field
          ? previous.direction === 'asc'
            ? 'desc'
            : 'asc'
          : field === 'title'
            ? 'asc'
            : 'desc',
      page: 1,
    }));
  }

  function openForm(document: Document | null, file: File | null = null) {
    setEditing(document);
    setDropped(file);
    create.reset();
    update.reset();
    setFormSession((n) => n + 1);
    setFormOpen(true);
  }

  async function submit(input: DocumentFormInput, upload: PendingUpload | null) {
    if (editing === null) {
      if (upload === null) return;
      await create.mutateAsync({ upload, input });
    } else {
      await update.mutateAsync({ id: editing.id, input });
    }
    setFormOpen(false);
  }

  function open(document: Document, disposition: 'inline' | 'attachment') {
    setOpenError(null);
    openDocument(document.id, disposition).catch((error: unknown) => {
      setOpenError(error instanceof ApiError ? error.message : 'Il file non si apre.');
    });
  }

  const data = list.data;
  const searching = debouncedQuery !== '';

  return (
    <div
      className="relative flex flex-col gap-6"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) setDragging(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDragLeave={(event) => {
        // Il `dragleave` scatta anche passando da un figlio all'altro: conta
        // solo l'uscita vera, cioè verso qualcosa che non sta qui dentro.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file !== undefined && !formOpen) openForm(null, file);
      }}
    >
      {dragging && !formOpen && (
        <div className="border-primary bg-background/80 pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed">
          <p className="text-lg font-medium">Rilascia per caricare il documento</p>
        </div>
      )}

      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Documenti</h1>
        {data !== undefined && (
          <p className="text-muted-foreground text-sm">
            {data.total === 1 ? '1 documento' : `${String(data.total)} documenti`}
          </p>
        )}
      </header>

      <div className="flex flex-col gap-3">
        <ResourceToolbar
          query={filters.q}
          onQueryChange={(value) => {
            setFilter('q', value);
          }}
          placeholder="Cerca per titolo, numero, note o etichetta"
          onCreate={() => {
            openForm(null);
          }}
          createLabel="Carica documento"
        >
          <FilterSelect
            label="Tipo"
            value={filters.kind}
            onChange={(value) => {
              setFilter('kind', value as DocumentKind | typeof ALL);
            }}
            options={KIND_OPTIONS}
            className="w-44"
          />
        </ResourceToolbar>

        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Cliente"
            value={filters.clientId}
            onChange={(value) => {
              setFilter('clientId', value);
            }}
            options={relationOptions(relations.clients, 'Tutti i clienti')}
            className="w-52"
          />
          <FilterSelect
            label="Fornitore"
            value={filters.vendorId}
            onChange={(value) => {
              setFilter('vendorId', value);
            }}
            options={relationOptions(relations.vendors, 'Tutti i fornitori')}
            className="w-52"
          />
          <div className="grid gap-1.5">
            <Label htmlFor="documents-from" className="text-muted-foreground text-xs">
              Data dal
            </Label>
            <Input
              id="documents-from"
              type="date"
              className="w-40"
              value={filters.from}
              onChange={(event) => {
                setFilter('from', event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="documents-to" className="text-muted-foreground text-xs">
              al
            </Label>
            <Input
              id="documents-to"
              type="date"
              className="w-40"
              value={filters.to}
              onChange={(event) => {
                setFilter('to', event.target.value);
              }}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilters(DEFAULT_DOCUMENT_FILTERS);
            }}
          >
            Azzera i filtri
          </Button>
        </div>
      </div>

      {(list.isError || openError !== null) && (
        <p className="text-sm text-red-600">
          {openError ??
            (list.error instanceof ApiError
              ? list.error.message
              : 'Errore imprevisto durante la lettura.')}
        </p>
      )}

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead field="title" label="Documento" filters={filters} onSort={sortBy} />
              <TableHead>Tipo</TableHead>
              <TableHead>Controparte</TableHead>
              <SortableHead field="issueDate" label="Data" filters={filters} onSort={sortBy} />
              <SortableHead field="dueDate" label="Scadenza" filters={filters} onSort={sortBy} />
              <SortableHead
                field="grossCents"
                label="Totale"
                filters={filters}
                onSort={sortBy}
                className="text-right"
              />
              <TableHead className="w-36" />
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
                  {searching
                    ? `Nessun documento per «${debouncedQuery}».`
                    : 'Nessun documento con questi filtri. Trascina qui un file per caricare il primo.'}
                </TableCell>
              </TableRow>
            )}

            {data?.items.map((document) => (
              <TableRow key={document.id}>
                <TableCell className="max-w-80">
                  <button
                    type="button"
                    className="text-left font-medium hover:underline"
                    onClick={() => {
                      open(document, 'inline');
                    }}
                  >
                    {document.title}
                  </button>
                  <p className="text-muted-foreground truncate text-xs">
                    {document.number === null ? '' : `n. ${document.number} · `}
                    {document.fileName} · {formatFileSize(document.sizeBytes)}
                  </p>
                  {document.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {document.tags.map((tag) => (
                        <Badge
                          key={tag}
                          variant="secondary"
                          className="cursor-pointer"
                          onClick={() => {
                            setFilter('q', tag);
                          }}
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {DOCUMENT_KIND_LABELS[document.kind]}
                </TableCell>
                <TableCell className="text-muted-foreground">{counterpart(document)}</TableCell>
                <TableCell className="tabular-nums">{formatDay(document.issueDate)}</TableCell>
                <TableCell className="tabular-nums">
                  {document.dueDate === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    formatDay(document.dueDate)
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {document.grossCents === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    formatMoney(document.grossCents, document.currency)
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Apri"
                      onClick={() => {
                        open(document, 'inline');
                      }}
                    >
                      <ExternalLink aria-hidden className="size-4" />
                      <span className="sr-only">Apri {document.title}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Scarica"
                      onClick={() => {
                        open(document, 'attachment');
                      }}
                    >
                      <Download aria-hidden className="size-4" />
                      <span className="sr-only">Scarica {document.title}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Modifica"
                      onClick={() => {
                        openForm(document);
                      }}
                    >
                      <Pencil aria-hidden className="size-4" />
                      <span className="sr-only">Modifica {document.title}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Elimina"
                      onClick={() => {
                        remove.reset();
                        setDeleting(document);
                      }}
                    >
                      <Trash2 aria-hidden className="size-4" />
                      <span className="sr-only">Elimina {document.title}</span>
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
          onPageChange={(page) => {
            setFilters((previous) => ({ ...previous, page }));
          }}
        />
      )}

      <DocumentFormDialog
        key={`${editing?.id ?? 'nuovo'}-${String(formSession)}`}
        open={formOpen}
        onOpenChange={setFormOpen}
        document={editing}
        initialFile={dropped}
        onSubmit={submit}
        pending={create.isPending || update.isPending}
        error={editing === null ? create.error : update.error}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminare il documento?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting === null ? null : (
                <>
                  «{deleting.title}» verrà eliminato insieme al file {deleting.fileName}, e non si
                  recupera.
                  {deleting.occurrenceCount > 0 &&
                    ` Le ${String(deleting.occurrenceCount)} scadenze a cui era allegato restano, senza allegato.`}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {remove.error !== null && (
            <p className="text-sm text-red-600">
              {remove.error instanceof ApiError
                ? remove.error.message
                : 'Eliminazione non riuscita.'}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (deleting === null) return;
                remove.mutateAsync(deleting.id).then(
                  () => {
                    setDeleting(null);
                  },
                  () => undefined,
                );
              }}
            >
              {remove.isPending ? 'Elimino…' : 'Elimina'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
