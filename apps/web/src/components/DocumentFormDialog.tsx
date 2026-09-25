import {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  type Document,
  type DocumentFormInput,
  type DocumentKind,
  type DocumentUploadTicket,
} from '@easygest/shared';
import {
  type ExtractedDocument,
  type ExtractionSource,
  type ResolvedCounterparty,
  resolveCounterparty,
} from '@easygest/shared/extraction';
import { FileUp, LoaderCircle, Sparkles, TriangleAlert } from 'lucide-react';
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
import { type ExtractionStep, extractDocument } from '@/lib/extract';
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

const FIELD_LABELS: Partial<Record<keyof DocumentFormState, string>> = {
  kind: 'tipo',
  title: 'titolo',
  number: 'numero',
  issueDate: 'data',
  dueDate: 'scadenza',
  netCents: 'imponibile',
  vatRateBp: 'aliquota',
  grossCents: 'totale',
  currency: 'valuta',
  clientId: 'cliente',
  vendorId: 'fornitore',
};

/**
 * Quello che si è letto dal file, messo nelle caselle che nessuno ha toccato.
 *
 * «Toccato» e non «vuoto»: il tipo e la data partono già valorizzati — fattura
 * ricevuta, oggi — e sono proprio due dei campi che il file sa meglio di un
 * default. Quello che invece l'utente ha scritto resta suo, anche se il file
 * dice altro: la lettura arriva qualche secondo dopo, e vedersi cambiare sotto
 * le dita una casella appena corretta sarebbe peggio di non avere l'aiuto.
 *
 * Restituisce anche l'elenco di ciò che ha scritto, perché l'avviso lo nomini:
 * «controlla» senza dire cosa non si fa.
 */
export function applyExtraction(
  form: DocumentFormState,
  touched: ReadonlySet<keyof DocumentFormState>,
  extracted: ExtractedDocument,
  resolved: ResolvedCounterparty,
): { form: DocumentFormState; filled: string[] } {
  const next = { ...form };
  const filled: string[] = [];
  const put = <K extends keyof DocumentFormState>(key: K, value: DocumentFormState[K] | null) => {
    if (value === null || value === '' || touched.has(key) || next[key] === value) return;
    next[key] = value;
    filled.push(FIELD_LABELS[key] ?? key);
  };

  const kind = resolved.kind ?? extracted.kind;
  put('kind', kind);
  put('number', extracted.number);
  put('issueDate', extracted.issueDate);
  put('dueDate', extracted.dueDate);
  put('netCents', extracted.netCents === null ? null : euroFromCents(extracted.netCents));
  put(
    'vatRateBp',
    extracted.vatRateBp === null ? null : percentFromBasisPoints(extracted.vatRateBp),
  );
  put('grossCents', extracted.grossCents === null ? null : euroFromCents(extracted.grossCents));
  put('currency', extracted.currency);
  put('clientId', resolved.clientId);
  put('vendorId', resolved.vendorId);

  // Solo dalla fattura elettronica, dove numero e controparte sono certi: un
  // titolo costruito su un numero letto male sarebbe un errore in più da
  // correggere, mentre quello dal nome del file è almeno fedele al file.
  if (extracted.source === 'fatturapa' && extracted.number !== null) {
    const party = kind === 'INVOICE_ACTIVE' ? extracted.customer : extracted.supplier;
    put('title', `Fattura ${extracted.number}${party?.name == null ? '' : ` ${party.name}`}`);
  }
  return { form: next, filled };
}

const SOURCE_LABELS: Record<ExtractionSource, string> = {
  fatturapa: 'dalla fattura elettronica',
  text: 'dal testo del PDF',
  ocr: 'con il riconoscimento del testo (OCR)',
};

type ExtractionState =
  | { status: 'idle' }
  | { status: 'running'; step: ExtractionStep }
  | {
      status: 'done';
      source: ExtractionSource;
      filled: string[];
      /** La controparte scritta sulla fattura, quando non è in anagrafica. */
      unknownParty: string | null;
    }
  | { status: 'failed' };

function ExtractionNotice({ state }: { state: ExtractionState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'running') {
    return (
      <p className="text-muted-foreground inline-flex items-center gap-2 text-sm">
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
        {state.step === 'ocr'
          ? 'Riconoscimento del testo della scansione… la prima volta scarica il modello, qualche secondo.'
          : 'Lettura del documento…'}
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <p className="text-muted-foreground text-sm">
        Non sono riuscito a leggere il file: compila i campi a mano.
      </p>
    );
  }
  return (
    <div className="flex gap-2 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
      <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div>
        {state.filled.length === 0 ? (
          <p>Nel file non ho trovato dati da compilare.</p>
        ) : (
          <p>
            Compilati {SOURCE_LABELS[state.source]}: {state.filled.join(', ')}.{' '}
            {state.source === 'fatturapa'
              ? 'Sono i dati della fattura, ma dagli un\u2019occhiata.'
              : 'Sono letti da un testo libero: controllali prima di salvare.'}
          </p>
        )}
        {state.unknownParty !== null && (
          <p className="mt-1">
            {state.unknownParty} non è fra i tuoi clienti o fornitori: aggiungilo in anagrafica per
            riconoscerlo la prossima volta.
          </p>
        )}
      </div>
    </div>
  );
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
  const [extraction, setExtraction] = useState<ExtractionState>({ status: 'idle' });
  const relations = useRelationOptions();
  const fileInput = useRef<HTMLInputElement>(null);
  const creating = document === null;

  // Le caselle scritte a mano, che la lettura del file non deve toccare.
  const touched = useRef(new Set<keyof DocumentFormState>());
  // L'anagrafica al momento in cui la lettura finisce, non a quello in cui è
  // partita: se nel frattempo è arrivata, la controparte si riconosce lo stesso.
  const known = useRef(relations);
  known.current = relations;
  // Cambiando file a lettura in corso, il risultato della prima non deve
  // arrivare sulle caselle della seconda.
  const reading = useRef(0);
  // Il modulo com'è adesso, per applicarci la lettura senza passare da un
  // aggiornamento funzionale — che React può rieseguire, e non restituisce
  // l'elenco di ciò che ha scritto.
  const current = useRef(form);
  current.current = form;

  const set =
    <K extends keyof DocumentFormState>(key: K) =>
    (value: DocumentFormState[K]) => {
      touched.current.add(key);
      setForm((previous) => ({ ...previous, [key]: value }));
    };

  function read(file: File) {
    reading.current += 1;
    const token = reading.current;
    setExtraction({ status: 'running', step: 'reading' });
    extractDocument(file, (step) => {
      if (reading.current === token) setExtraction({ status: 'running', step });
    }).then(
      (result) => {
        if (reading.current !== token) return;
        if (result === null) {
          setExtraction({ status: 'failed' });
          return;
        }
        const { extracted, text } = result;
        const resolved = resolveCounterparty(
          extracted,
          { clients: known.current.clients, vendors: known.current.vendors },
          text,
        );
        const applied = applyExtraction(current.current, touched.current, extracted, resolved);
        setForm(applied.form);

        const kind = resolved.kind ?? extracted.kind;
        const party = kind === 'INVOICE_ACTIVE' ? extracted.customer : extracted.supplier;
        const unresolved =
          extracted.source === 'fatturapa' &&
          resolved.clientId === null &&
          resolved.vendorId === null;
        setExtraction({
          status: 'done',
          source: extracted.source,
          filled: applied.filled,
          unknownParty:
            unresolved && party?.name != null
              ? `${party.name}${party.vatNumber === null ? '' : ` (P.IVA ${party.vatNumber})`}`
              : null,
        });
      },
      () => {
        if (reading.current === token) setExtraction({ status: 'failed' });
      },
    );
  }

  function choose(file: File) {
    setUpload({ status: 'preparing', file });
    read(file);
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
              <ExtractionNotice state={extraction} />
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
