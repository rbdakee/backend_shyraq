import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * Raised when a stream key is already bound to another camera row.
 *
 * The key namespace of the media gateway is flat and shared by every tenant,
 * so the conflicting row may well belong to a kindergarten the caller cannot
 * see. The message therefore names the key and nothing else — no tenant, no
 * camera id — since either would leak the existence of a neighbouring
 * tenant's configuration.
 */
export class CameraStreamKeyTakenError extends ConflictError {
  constructor(streamKey: string) {
    super(
      'camera_stream_key_taken',
      `stream key ${streamKey} is already assigned to another camera`,
    );
  }
}
