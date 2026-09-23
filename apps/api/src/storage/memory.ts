import { Readable } from 'node:stream';

import type { Storage } from './types';

/**
 * Lo storage dei test: una `Map` invece di un bucket.
 *
 * Il caricamento vero lo fa il browser, fuori dall'API; nei test lo simula
 * `put`, che è l'unico metodo che l'interfaccia non ha.
 */
export interface MemoryStorage extends Storage {
  readonly objects: Map<string, { bytes: Buffer; contentType: string }>;
  put(key: string, bytes: Buffer | string, contentType?: string): void;
}

export function createMemoryStorage(): MemoryStorage {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();

  return {
    objects,
    put(key, bytes, contentType = 'application/pdf') {
      objects.set(key, { bytes: Buffer.from(bytes), contentType });
    },
    presignUpload(request) {
      return Promise.resolve({
        url: `memory://upload/${request.key}`,
        method: 'PUT',
        headers: { 'content-type': request.contentType },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });
    },
    presignDownload(key, request) {
      return Promise.resolve(
        `memory://download/${key}?disposition=${request.disposition}&name=${encodeURIComponent(request.fileName)}`,
      );
    },
    head(key) {
      const object = objects.get(key);
      return Promise.resolve(
        object === undefined
          ? null
          : { sizeBytes: object.bytes.length, contentType: object.contentType },
      );
    },
    read(key) {
      const object = objects.get(key);
      if (object === undefined) return Promise.reject(new Error(`oggetto ${key} inesistente`));
      return Promise.resolve(Readable.from([object.bytes]));
    },
    delete(key) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
}
