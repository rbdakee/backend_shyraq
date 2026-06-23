import { Provider } from '@nestjs/common';
import { FileStoragePort } from './file-storage.port';
import { LocalFileStorageAdapter } from './adapters/local-file-storage.adapter';
import {
  S3FileStorageAdapter,
  S3FileStorageOptions,
} from './adapters/s3-file-storage.adapter';

/**
 * Reads + validates the S3-compatible adapter config from the environment.
 * Fails loudly at bootstrap (rather than at first upload) if a required
 * credential is missing, matching the FCM/Kaspi adapter convention.
 *
 * Environments are isolated by BUCKET (not key-prefix): set
 * `FILE_STORAGE_BUCKET` per env — `balam-media` (prod), `balam-media-dev`
 * (dev / staging / other).
 *
 * ps.kz Object Storage (Universal tariff):
 *   FILE_STORAGE_ENDPOINT=https://object.pscloud.io   (virtual-hosted style)
 *   FILE_STORAGE_REGION=us-east-1                       (placeholder — ignored)
 *   FILE_STORAGE_FORCE_PATH_STYLE unset/false
 */
function readS3StorageOptions(): S3FileStorageOptions {
  const required = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value.trim() === '') {
      throw new Error(
        `FILE_STORAGE_PROVIDER=s3 requires ${name} to be set (see env-example-relational).`,
      );
    }
    return value;
  };
  const forcePathStyleRaw = (
    process.env.FILE_STORAGE_FORCE_PATH_STYLE ?? ''
  ).toLowerCase();
  return {
    bucket: required('FILE_STORAGE_BUCKET'),
    region: process.env.FILE_STORAGE_REGION || 'us-east-1',
    accessKeyId: required('FILE_STORAGE_ACCESS_KEY'),
    secretAccessKey: required('FILE_STORAGE_SECRET_KEY'),
    endpoint: process.env.FILE_STORAGE_ENDPOINT || undefined,
    forcePathStyle: forcePathStyleRaw === 'true',
    urlPrefix: process.env.FILE_STORAGE_URL_PREFIX || undefined,
  };
}

/**
 * Picks the file-storage adapter based on `process.env.FILE_STORAGE_PROVIDER`.
 * Defaults to `local` (Phase A). `s3` / `yandex` bind the S3-compatible
 * adapter (B17 Phase B) — both share the same code path, differing only by
 * the `FILE_STORAGE_ENDPOINT` / `FILE_STORAGE_FORCE_PATH_STYLE` config.
 *
 * `FILE_STORAGE_LOCAL_DIR` (default `uploads`) is the on-disk root for
 * local storage.
 *
 * Shared so any module needing `FileStoragePort` (Content, Users, …) binds
 * an identical adapter without duplicating the env-switch logic or coupling
 * to `ContentModule`. See `StorageModule`.
 */
export function fileStorageProvider(): Provider {
  return {
    provide: FileStoragePort,
    useFactory: () => {
      const provider = (
        process.env.FILE_STORAGE_PROVIDER ?? 'local'
      ).toLowerCase();
      if (provider === 'local') {
        return new LocalFileStorageAdapter({
          uploadsDir: process.env.FILE_STORAGE_LOCAL_DIR ?? 'uploads',
        });
      }
      if (provider === 's3' || provider === 'yandex') {
        return new S3FileStorageAdapter(readS3StorageOptions());
      }
      throw new Error(
        `File storage provider '${provider}' not implemented; configure FILE_STORAGE_PROVIDER=local|s3|yandex`,
      );
    },
  };
}
