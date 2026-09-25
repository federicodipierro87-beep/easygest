import {
  type Document,
  type DocumentCreate,
  type DocumentFormInput,
  type DocumentKind,
  type DocumentMimeType,
  type DocumentUploadTicket,
  DOCUMENT_MIME_TYPES,
  type Paginated,
  mimeTypeFromFileName,
} from '@easygest/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { ALL } from './expenses';
import { queryString } from './resources';
import { authFetch } from './session';

/**
 * L'archivio visto dal browser.
 *
 * La parte che non somiglia a nessun altro modulo è `startUpload`: è l'unico
 * punto dell'applicazione che parla con un server che non è la nostra API, e
 * per questo l'unico che usa `fetch` nudo invece di `authFetch`. Il bucket non
 * sa cosa sia un token di EasyGest, e mandarglielo vorrebbe dire consegnare
 * una credenziale a un terzo; l'autorizzazione è già tutta dentro la firma
 * dell'URL.
 */

export interface DocumentFilters {
  q: string;
  page: number;
  kind: DocumentKind | typeof ALL;
  clientId: string;
  vendorId: string;
  from: string;
  to: string;
  sort: 'issueDate' | 'dueDate' | 'title' | 'grossCents';
  direction: 'asc' | 'desc';
}

export const DEFAULT_DOCUMENT_FILTERS: DocumentFilters = {
  q: '',
  page: 1,
  kind: ALL,
  clientId: ALL,
  vendorId: ALL,
  from: '',
  to: '',
  sort: 'issueDate',
  direction: 'desc',
};

function chosen(value: string): string | undefined {
  return value === ALL || value === '' ? undefined : value;
}

export function documentQueryString(filters: DocumentFilters): string {
  return queryString([
    ['q', chosen(filters.q)],
    ['page', filters.page === 1 ? undefined : String(filters.page)],
    ['kind', chosen(filters.kind)],
    ['clientId', chosen(filters.clientId)],
    ['vendorId', chosen(filters.vendorId)],
    ['from', chosen(filters.from)],
    ['to', chosen(filters.to)],
    ['sort', filters.sort === 'issueDate' ? undefined : filters.sort],
    ['direction', filters.direction === 'desc' ? undefined : filters.direction],
  ]);
}

export const documentKeys = {
  all: ['documents'] as const,
  list: (filters: DocumentFilters) => ['documents', 'list', filters] as const,
};

export function documentListQueryOptions(filters: DocumentFilters) {
  return queryOptions({
    queryKey: documentKeys.list(filters),
    queryFn: () => authFetch<Paginated<Document>>(`/documents?${documentQueryString(filters)}`),
    placeholderData: (previous: Paginated<Document> | undefined) => previous,
  });
}

/**
 * Il tipo del file, preferendo l'estensione a quello che dice il browser.
 *
 * Al contrario di quanto verrebbe spontaneo, e per una ragione precisa: il
 * browser deduce il tipo dall'estensione comunque, ma per le due che contano
 * di più sbaglia in modi diversi a seconda del sistema — un `.p7m` arriva
 * vuoto, un `.xml` come `text/xml` su un computer e `application/xml`
 * sull'altro. Due fatture elettroniche identiche finirebbero con due tipi.
 */
export function mimeTypeOf(file: Pick<File, 'name' | 'type'>): DocumentMimeType | null {
  const fromName = mimeTypeFromFileName(file.name);
  if (fromName !== null) return fromName;
  return (DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type)
    ? (file.type as DocumentMimeType)
    : null;
}

/**
 * Un titolo di partenza dal nome del file: senza estensione, senza trattini.
 *
 * Non pretende di indovinare — «Fattura_Aruba_2026-03» diventa «Fattura Aruba
 * 2026-03» — ma risparmia di riscrivere quello che il nome dice già, che per
 * un PDF salvato da un'email è quasi sempre abbastanza.
 */
export function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/(\.[a-z0-9]{1,4})+$/i, '');
  const spaced = withoutExtension.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced === '' ? fileName : spaced;
}

async function sha256Hex(file: Blob): Promise<string> {
  // Il file intero in memoria: con il limite di 25 MB è un prezzo accettabile,
  // e `crypto.subtle` non ha un'interfaccia a flusso.
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Un caricamento avviato: il biglietto subito, il file quando arriva. */
export interface PendingUpload {
  ticket: DocumentUploadTicket;
  file: DocumentCreate['file'];
  /** Si risolve quando il bucket ha il file, o fallisce con un `UploadError`. */
  done: Promise<void>;
}

/**
 * Impronta, biglietto, e il PUT che parte senza aspettare nessuno.
 *
 * Il caricamento comincia appena il file è scelto, non al salvataggio: mentre
 * si scrive il titolo il file è già in viaggio, e su una fattura da due mega il
 * tasto «Salva» risponde subito invece che dopo una barra di avanzamento.
 * Restituisce il biglietto senza aspettare il PUT, così i doppioni si vedono
 * prima di aver compilato niente.
 */
export async function startUpload(file: File): Promise<PendingUpload> {
  const mimeType = mimeTypeOf(file);
  if (mimeType === null) {
    throw new UploadError(
      'Tipo di file non ammesso: servono PDF, immagini o fatture elettroniche.',
    );
  }
  const announced = {
    fileName: file.name,
    mimeType,
    sizeBytes: file.size,
    checksumSha256: await sha256Hex(file),
  };
  const ticket = await authFetch<DocumentUploadTicket>('/documents/uploads', {
    method: 'POST',
    body: JSON.stringify(announced),
  });

  const done = fetch(ticket.upload.url, {
    method: ticket.upload.method,
    headers: ticket.upload.headers,
    body: file,
  }).then(
    (response) => {
      if (!response.ok) {
        throw new UploadError(
          `Il bucket ha rifiutato il file (${String(response.status)}). Riprova a sceglierlo.`,
        );
      }
    },
    () => {
      // Un errore di rete qui, e non una risposta, è quasi sempre il CORS del
      // bucket: il browser non lascia leggere nemmeno lo stato. Vale la pena
      // dirlo, perché da nessun'altra parte si vedrebbe.
      throw new UploadError(
        'Il file non è arrivato allo storage: controlla la connessione, o il CORS del bucket.',
      );
    },
  );
  // Senza, un PUT fallito prima che qualcuno lo aspetti diventerebbe un
  // «unhandled rejection» nella console: chi salva lo rilegge comunque da `done`.
  done.catch(() => undefined);

  return { ticket, file: { ...announced, storageKey: ticket.storageKey }, done };
}

export function useDocumentMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: documentKeys.all });

  const create = useMutation({
    mutationFn: async ({ upload, input }: { upload: PendingUpload; input: DocumentFormInput }) => {
      await upload.done;
      return authFetch<Document>('/documents', {
        method: 'POST',
        body: JSON.stringify({ document: input, file: upload.file }),
      });
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: DocumentFormInput }) =>
      authFetch<Document>(`/documents/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => authFetch<void>(`/documents/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

/**
 * Apre o scarica il file, dal bucket.
 *
 * La finestra si apre **prima** di chiedere l'URL, vuota, e solo dopo riceve
 * l'indirizzo. Al contrario — `await` e poi `window.open` — il browser non
 * vedrebbe più il clic dietro all'apertura e la bloccherebbe come un popup.
 * Lo scaricamento invece non apre niente: `Content-Disposition: attachment`
 * fa sì che il browser salvi il file senza lasciare la pagina.
 */
export async function openDocument(id: string, disposition: 'inline' | 'attachment') {
  const target = disposition === 'inline' ? window.open('', '_blank') : null;
  try {
    const { url } = await authFetch<{ url: string }>(
      `/documents/${id}/download?${queryString([['disposition', disposition]])}`,
    );
    if (target === null) {
      window.location.assign(url);
    } else {
      target.opener = null;
      target.location.href = url;
    }
  } catch (error) {
    target?.close();
    throw error;
  }
}

/** «2,4 MB», «312 kB»: quanto basta per riconoscere un file. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString('it-IT')} kB`;
  return `${(bytes / 1024 / 1024).toLocaleString('it-IT', { maximumFractionDigits: 1 })} MB`;
}
