import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { type Env, resolveS3Config, resolveStorageDriver } from '../config/env';
import { createMemoryStorage } from './memory';
import { createS3Storage } from './s3';
import type { Storage } from './types';

export { createMemoryStorage, type MemoryStorage } from './memory';
export { contentDisposition } from './types';
export type { PresignedUpload, Storage, StoredObject } from './types';

declare module 'fastify' {
  interface FastifyInstance {
    storage: Storage;
  }
}

export function createStorage(env: Env): Storage {
  return resolveStorageDriver(env) === 'memory'
    ? createMemoryStorage()
    : createS3Storage(resolveS3Config(env));
}

/** Come il mailer: dentro `buildApp`, e da solo in memoria con `NODE_ENV=test`. */
export const storagePlugin = fp(
  function storagePlugin(app: FastifyInstance, env: Env): Promise<void> {
    const driver = resolveStorageDriver(env);
    app.decorate('storage', createStorage(env));
    // Endpoint e bucket nei log, le chiavi mai.
    app.log.info(
      driver === 's3'
        ? { driver, endpoint: resolveS3Config(env).endpoint, bucket: resolveS3Config(env).bucket }
        : { driver },
      'Storage dei documenti configurato',
    );
    return Promise.resolve();
  },
  { name: 'storage' },
);
