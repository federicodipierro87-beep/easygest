import {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  type Document,
  type DocumentFormInput,
  type DocumentKind,
  type DocumentUploadTicket,
} from '@easygest/shared';
import { FileUp, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { SelectField, TextAreaField, TextField } from '@/components/FormField';
import { RelationSelect } from '@/components/RelationSelect';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import {
  type PendingUpload,
  UploadError,
  formatFileSize,
  startUpload,
  titleFromFileName,
} from '@/lib/documents';
import {
  euroFromCents,
  formatDay,
  parseEuro,
  parsePercent,
  percentFromBasisPoints,
  todayIso,
  type ParsedNumber,
} from '@/lib/format';
import { useRelationOptions, withMissing } from '@/lib/relations';
import { fieldErrors } from '@/lib/resources';

/**
 * Il modulo di un documento: per caricarne uno nuovo o per correggerne i dati.
 *
 * Il file non si sostituisce, nemmeno in modifica. Un documento con un altro
 * file è un altro documento: l'impronta cambierebbe, e con lei la ragione per
 * cui un doppione è stato riconosciuto o no. Si cancella e si ricarica.
 */

export interface DocumentFormState {
  kind: DocumentKind;
  title: string;
  number: string;
  issueDate: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  clientId: string | null;
  vendorId: string | null;
  categoryId: string | null;
  netCents: string;
  vatRateBp: string;
  grossCents: string;
  currency: string;
  /** Separate da virgola, come si scrivono. */
  tags: string;
  notes: string;
}

export function documentForm(document: Document | null, today: string = todayIso()) {
  if (document === null) {
    return {
      kind: 'INVOICE_PASSIVE',
      title: '',
      number: '',
      issueDate: today,
      dueDate: '',
      periodStart: '',
      periodEnd: '',
      clientId: null,
      vendorId: null,
      categoryId: null,
      netCents: '',
      vatRateBp: '',
      grossCents: '',
      currency: 'EUR',
      tags: '',
      notes: '',
    } satisfies DocumentFormState;
  }
  return {
    kind: document.kind,
    title: document.title,
    number: document.number ?? '',
    issueDate: document.issueDate,
    dueDate: document.dueDate ?? '',
    periodStart: document.periodStart ?? '',
    periodEnd: document.periodEnd ?? '',
    clientId: document.clientId,
    vendorId: document.vendorId,
    categoryId: document.categoryId,
    netCents: euroFromCents(document.netCents),
    vatRateBp: percentFromBasisPoints(document.vatRateBp),
    grossCents: euroFromCents(document.grossCents),
    currency: document.currency,
    tags: document.tags.join(', '),
    notes: document.notes ?? '',
  } satisfies DocumentFormState;
}

/**
 * Quali controparti ha senso proporre.
 *
 * Le stesse due regole del `superRefine` di `documentInputSchema`, viste come
 * caselle che non ci sono: una fattura emessa non ha un fornitore da scegliere.
 */
export function counterparts(kind: DocumentKind) {
  return {
    client: kind !== 'INVOICE_PASSIVE' && kind !== 'RECEIPT',
    vendor: kind !== 'INVOICE_ACTIVE',
  };
}

export type PreparedDocument =
  { ok: true; input: DocumentFormInput } | { ok: false; errors: Record<string, string> };

const NOT_A_NUMBER = 'Questo non è un numero';
const numberOrNull = (parsed: ParsedNumber) => (typeof parsed === 'number' ? parsed : null);

export function toDocumentInput(form: DocumentFormState): PreparedDocument {
  const netCents = parseEuro(form.netCents);
  const grossCents = parseEuro(form.grossCents);
  const vatRateBp = parsePercent(form.vatRateBp);

  const errors: Record<string, string> = {};
  if (netCents === 'invalido') errors.netCents = NOT_A_NUMBER;
  if (grossCents === 'invalido') errors.grossCents = NOT_A_NUMBER;
  if (vatRateBp === 'invalido') errors.vatRateBp = NOT_A_NUMBER;
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const net = numberOrNull(netCents);
  const gross = numberOrNull(grossCents);
  const visible = counterparts(form.kind);
  const empty = (value: string) => (value === '' ? null : value);

  return {
    ok: true,
    input: {
      kind: form.kind,
      title: form.title,
      number: empty(form.number.trim()),
      issueDate: form.issueDate,
      dueDate: empty(form.dueDate),
      periodStart: empty(form.periodStart),
      periodEnd: empty(form.periodEnd),
      paidAt: null,
      clientId: visible.client ? form.clientId : null,
      vendorId: visible.vendor ? form.vendorId : null,
      categoryId: form.categoryId,
      netCents: net,
      vatRateBp: numberOrNull(vatRateBp),
      // L'IVA è la differenza fra i due, quando ci sono entrambi: è scritta sul
      // foglio anche lei, e non è un conto nostro ma una sottrazione.
      vatCents: net !== null && gross !== null ? gross - net : null,
      grossCents: gross,
      currency: form.currency.trim() === '' ? 'EUR' : form.currency,
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ''),
      notes: empty(form.notes.trim()),
    },
  };
}

/**
 * Gli errori dell'API riportati sulle caselle.
 *
 * Alla registrazione il corpo è `{ document, file }`, quindi i campi tornano
 * come `document.title`: il prefisso si toglie, perché la casella si chiama
 * `title` in tutte e due le strade.
 */
function documentFieldErrors(error: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [field, message] of Object.entries(fieldErrors(error))) {
    result[field.replace(/^document\./, '')] = message;
  }
  return result;
}

const KIND_OPTIONS = DOCUMENT_KINDS.map((kind) => ({
  value: kind,
  label: DOCUMENT_KIND_LABELS[kind],
}));

type UploadState =
  | { status: 'none' }
  | { status: 'preparing'; file: File }
  | { status: 'uploading' | 'uploaded'; file: File; pending: PendingUpload }
  | { status: 'failed'; file: File; message: string };

function Duplicates({ duplicates }: { duplicates: DocumentUploadTicket['duplicates'] }) {
  if (duplicates.length === 0) return null;
  return (
    <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-medium">Questo file è già in archivio</p>
        <ul className="mt-1 list-disc pl-4">
          {duplicates.map((duplicate) => (
            <li key={duplicate.id}>
              {duplicate.title} · {DOCUMENT_KIND_LABELS[duplicate.kind]} del{' '}
              {formatDay(duplicate.issueDate)}
            </li>
          ))}
        </ul>
        <p className="mt-1">Puoi salvarlo lo stesso, se deve comparire due volte.</p>
      </div>
    </div>
  );
}

interface DocumentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` per un caricamento. */
  document: Document | null;
  /** Il file trascinato sulla pagina, se il caricamento parte da lì. */
  initialFile?: File | null;
  onSubmit: (input: DocumentFormInput, upload: PendingUpload | null) => Promise<void>;
  pending: boolean;
  error: unknown;
}

export function DocumentFormDialog({
  open,
  onOpenChange,
  document,
  initialFile = null,
  onSubmit,
  pending,
  error,
}: DocumentFormDialogProps) {
  const [form, setForm] = useState<DocumentFormState>(() => documentForm(document));
  const [local, setLocal] = useState<Record<string, string>>({});
  const [upload, setUpload] = useState<UploadState>({ status: 'none' });
  const relations = useRelationOptions();
  const fileInput = useRef<HTMLInputElement>(null);
  const creating = document === null;

  const set =
    <K extends keyof DocumentFormState>(key: K) =>
    (value: DocumentFormState[K]) => {
      setForm((previous) => ({ ...previous, [key]: value }));
    };

  function choose(file: File) {
    setUpload({ status: 'preparing', file });
    // Il titolo si propone solo se è ancora vuoto: chi l'ha già scritto e poi
    // cambia file non deve vederselo sovrascrivere.
    setForm((previous) =>
      previous.title === '' ? { ...previous, title: titleFromFileName(file.name) } : previous,
    );
    startUpload(file).then(
      (pending) => {
        setUpload({ status: 'uploading', file, pending });
        pending.done.then(
          () => {
            setUpload((current) =>
              current.status === 'uploading' && current.pending === pending
                ? { status: 'uploaded', file, pending }
                : current,
            );
          },
          (reason: unknown) => {
            setUpload((current) =>
              current.status === 'uploading' && current.pending === pending
                ? { status: 'failed', file, message: messageOf(reason) }
                : current,
            );
          },
        );
      },
      (reason: unknown) => {
        setUpload({ status: 'failed', file, message: messageOf(reason) });
      },
    );
  }

  // Il file trascinato sulla pagina parte appena la finestra si apre.
  const started = useRef(false);
  useEffect(() => {
    if (initialFile !== null && !started.current) {
      started.current = true;
      choose(initialFile);
    }
  });

  const errors = { ...documentFieldErrors(error), ...local };
  const generalError =
    error instanceof ApiError && Object.keys(documentFieldErrors(error)).length === 0
      ? error.message
      : error instanceof UploadError
        ? error.message
        : null;
  const visible = counterparts(form.kind);
  const hasFile = upload.status === 'uploading' || upload.status === 'uploaded';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{creating ? 'Carica un documento' : 'Modifica documento'}</DialogTitle>
          <DialogDescription>
            {creating
              ? 'Il file parte subito; intanto compila tipo, titolo e data. Il resto è facoltativo.'
              : `Il file resta ${document.fileName}: per cambiarlo, elimina il documento e caricalo di nuovo.`}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (creating && !hasFile) {
              setLocal({ file: 'Scegli il file da caricare' });
              return;
            }
            const prepared = toDocumentInput(form);
            if (!prepared.ok) {
              setLocal(prepared.errors);
              return;
            }
            setLocal({});
            void onSubmit(prepared.input, hasFile ? upload.pending : null);
          }}
        >
          {creating && (
            <div className="grid gap-2">
              <div
                className="flex flex-wrap items-center gap-3 rounded-md border border-dashed p-4"
                onDragOver={(event) => {
                  event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const file = event.dataTransfer.files[0];
                  if (file !== undefined) choose(file);
                }}
              >
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    fileInput.current?.click();
                  }}
                >
                  <FileUp aria-hidden className="size-4" />
                  {upload.status === 'none' ? 'Scegli il file' : 'Cambia file'}
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  accept=".pdf,.jpg,.jpeg,.png,.webp,.xml,.p7m"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) choose(file);
                    event.target.value = '';
                  }}
                />
                {upload.status === 'none' ? (
                  <span className="text-muted-foreground text-sm">
                    o trascinalo qui. PDF, immagini, fatture elettroniche (.xml, .p7m).
                  </span>
                ) : (
                  <span className="text-sm">
                    <span className="font-medium">{upload.file.name}</span>{' '}
                    <span className="text-muted-foreground">
                      · {formatFileSize(upload.file.size)} ·{' '}
                    </span>
                    <UploadStatus state={upload} />
                  </span>
                )}
              </div>
              {errors.file !== undefined && <p className="text-sm text-red-600">{errors.file}</p>}
              {hasFile && <Duplicates duplicates={upload.pending.ticket.duplicates} />}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              id="document-kind"
              label="Tipo"
              value={form.kind}
              onChange={(value) => {
                set('kind')(value as DocumentKind);
              }}
              options={KIND_OPTIONS}
              error={errors.kind}
            />
            <div className="sm:col-span-2">
              <TextField
                id="document-title"
                label="Titolo"
                value={form.title}
                onChange={set('title')}
                error={errors.title}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              id="document-number"
              label="Numero"
              value={form.number}
              onChange={set('number')}
              error={errors.number}
              hint="Come lo ha scritto chi l’ha emesso."
            />
            <TextField
              id="document-issue-date"
              label="Data del documento"
              type="date"
              value={form.issueDate}
              onChange={set('issueDate')}
              error={errors.issueDate}
            />
            <TextField
              id="document-due-date"
              label="Scadenza"
              type="date"
              value={form.dueDate}
              onChange={set('dueDate')}
              error={errors.dueDate}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {visible.client && (
              <RelationSelect
                id="document-client"
                label="Cliente"
                value={form.clientId}
                onChange={set('clientId')}
                options={withMissing(
                  relations.clients,
                  form.clientId,
                  document?.clientName ?? null,
                )}
                emptyLabel="Nessun cliente"
                error={errors.clientId}
                disabled={relations.loading}
              />
            )}
            {visible.vendor && (
              <RelationSelect
                id="document-vendor"
                label="Fornitore"
                value={form.vendorId}
                onChange={set('vendorId')}
                options={withMissing(
                  relations.vendors,
                  form.vendorId,
                  document?.vendorName ?? null,
                )}
                emptyLabel="Nessun fornitore"
                error={errors.vendorId}
                disabled={relations.loading}
              />
            )}
            <RelationSelect
              id="document-category"
              label="Categoria"
              value={form.categoryId}
              onChange={set('categoryId')}
              options={withMissing(
                relations.categories,
                form.categoryId,
                document?.categoryName ?? null,
              )}
              emptyLabel="Nessuna categoria"
              error={errors.categoryId}
              disabled={relations.loading}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <TextField
              id="document-net"
              label="Imponibile"
              value={form.netCents}
              onChange={set('netCents')}
              error={errors.netCents}
              placeholder="0,00"
            />
            <TextField
              id="document-vat"
              label="IVA %"
              value={form.vatRateBp}
              onChange={set('vatRateBp')}
              error={errors.vatRateBp}
            />
            <TextField
              id="document-gross"
              label="Totale"
              value={form.grossCents}
              onChange={set('grossCents')}
              error={errors.grossCents}
              placeholder="0,00"
            />
            <TextField
              id="document-currency"
              label="Valuta"
              value={form.currency}
              onChange={set('currency')}
              error={errors.currency}
            />
          </div>
          <p className="text-muted-foreground -mt-2 text-xs">
            Gli importi sono quelli scritti sul documento, e nessuno si ricava dagli altri: un
            contratto può non averne affatto.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              id="document-period-start"
              label="Competenza dal"
              type="date"
              value={form.periodStart}
              onChange={set('periodStart')}
              error={errors.periodStart}
            />
            <TextField
              id="document-period-end"
              label="al"
              type="date"
              value={form.periodEnd}
              onChange={set('periodEnd')}
              error={errors.periodEnd}
            />
            <TextField
              id="document-tags"
              label="Etichette"
              value={form.tags}
              onChange={set('tags')}
              error={errors.tags}
              hint="Separate da virgola."
            />
          </div>

          <TextAreaField
            id="document-notes"
            label="Note"
            value={form.notes}
            onChange={set('notes')}
            error={errors.notes}
          />

          {generalError !== null && <p className="text-sm text-red-600">{generalError}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Annulla
            </Button>
            <Button type="submit" disabled={pending || upload.status === 'preparing'}>
              {pending ? 'Salvataggio…' : 'Salva'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UploadStatus({ state }: { state: Exclude<UploadState, { status: 'none' }> }) {
  switch (state.status) {
    case 'preparing':
      return (
        <span className="text-muted-foreground inline-flex items-center gap-1">
          <LoaderCircle aria-hidden className="size-3 animate-spin" /> preparazione…
        </span>
      );
    case 'uploading':
      return (
        <span className="text-muted-foreground inline-flex items-center gap-1">
          <LoaderCircle aria-hidden className="size-3 animate-spin" /> caricamento…
        </span>
      );
    case 'uploaded':
      return <span className="text-emerald-700 dark:text-emerald-400">caricato</span>;
    case 'failed':
      return <span className="text-red-600">{state.message}</span>;
  }
}

function messageOf(reason: unknown): string {
  if (reason instanceof UploadError || reason instanceof ApiError) return reason.message;
  return 'Caricamento non riuscito.';
}
