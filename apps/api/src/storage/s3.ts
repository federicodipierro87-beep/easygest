import type { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { S3Config } from '../config/env';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  type Storage,
  UPLOAD_URL_TTL_SECONDS,
  contentDisposition,
} from './types';

const hexToBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

/**
 * Lo storage vero: MinIO in locale, R2 in produzione, stesso codice.
 */
export function createS3Storage(config: S3Config): Storage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Dalla 3.729 l'SDK aggiunge da sé un checksum CRC32 a ogni richiesta, URL
    // firmati compresi. R2 non lo accetta in un URL firmato e risponde 400, e
    // il checksum che vogliamo noi — SHA-256 — lo mettiamo comunque a mano.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return {
    async presignUpload(request) {
      const checksum = hexToBase64(request.checksumSha256);
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: request.key,
        ContentType: request.contentType,
        ContentLength: request.sizeBytes,
        ChecksumSHA256: checksum,
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: UPLOAD_URL_TTL_SECONDS,
        // Firmati come header e non spostati nella query string: così è lo
        // storage a rifiutare un file più grosso o diverso da quello
        // annunciato, invece di doverlo scoprire noi dopo.
        signableHeaders: new Set(['content-type', 'content-length']),
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      });
      return {
        url,
        method: 'PUT',
        headers: {
          'content-type': request.contentType,
          'x-amz-checksum-sha256': checksum,
        },
        expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000),
      };
    },

    presignDownload(key, request) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ResponseContentType: request.contentType,
          ResponseContentDisposition: contentDisposition(request),
        }),
        { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
      );
    },

    async head(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType };
      } catch (error) {
        // Una HEAD non ha corpo, quindi niente `NoSuchKey`: l'unico segnale
        // di «non c'è» è lo stato HTTP.
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
          return null;
        }
        throw error;
      }
    },

    async read(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return result.Body as Readable;
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
