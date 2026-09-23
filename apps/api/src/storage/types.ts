import type { Readable } from 'node:stream';

/**
 * Il confine fra l'archivio e il posto in cui stanno i file.
 *
 * Stessa ragione del `Mailer`: le rotte dei documenti si provano senza rete e
 * senza bucket, perché nei test lo storage è una `Map`. L'interfaccia è
 * piccola di proposito — ciò che non c'è qui, come elencare un bucket, non
 * serve all'applicazione, e ogni metodo in più è un metodo da tenere uguale
 * in due implementazioni.
 */

export interface UploadRequest {
  key: string;
  contentType: string;
  sizeBytes: number;
  /** SHA-256 del contenuto, in esadecimale minuscolo: com'è in `Document`. */
  checksumSha256: string;
}

/**
 * Tutto ciò che serve al browser per caricare il file **direttamente** sullo
 * storage, senza passare dall'API.
 *
 * `headers` va mandato così com'è: dimensione, tipo e checksum sono firmati
 * dentro l'URL, e un header diverso invalida la firma. È il punto — il file
 * che arriva deve essere quello annunciato, non uno qualsiasi.
 */
export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DownloadRequest {
  fileName: string;
  contentType: string;
  /** `inline` apre il PDF nel browser, `attachment` lo scarica. */
  disposition: 'inline' | 'attachment';
}

export interface StoredObject {
  sizeBytes: number;
  contentType: string | undefined;
}

export interface Storage {
  presignUpload(request: UploadRequest): Promise<PresignedUpload>;
  presignDownload(key: string, request: DownloadRequest): Promise<string>;
  /** `null` se l'oggetto non c'è: è la risposta attesa di un caricamento non finito. */
  head(key: string): Promise<StoredObject | null>;
  read(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

/** Quanto vive un URL firmato. Breve: chi lo intercetta ha in mano un documento fiscale. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * `Content-Disposition` con un nome di file qualunque.
 *
 * Il nome ASCII è per i client vecchi, `filename*` (RFC 5987) per tutti gli
 * altri: «Fattura n°12 — maggio.pdf» ha tre caratteri che un header nudo non
 * può portare, e senza la seconda forma il browser salverebbe «download».
 */
export function contentDisposition(request: Pick<DownloadRequest, 'fileName' | 'disposition'>) {
  const ascii = request.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(request.fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${request.disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
