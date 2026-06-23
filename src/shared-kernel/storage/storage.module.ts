import { Module } from '@nestjs/common';
import { FileStoragePort } from './file-storage.port';
import { fileStorageProvider } from './file-storage.provider';

/**
 * Binds + exports `FileStoragePort` via the shared env-switch factory so any
 * feature module (Users avatar upload, Content media, …) can depend on file
 * storage without importing `ContentModule` (which pulls Child/Group and
 * risks cycles). Import this module wherever `FileStoragePort` is injected.
 */
@Module({
  providers: [fileStorageProvider()],
  exports: [FileStoragePort],
})
export class StorageModule {}
