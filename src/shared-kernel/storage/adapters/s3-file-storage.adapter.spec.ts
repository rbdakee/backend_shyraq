import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  FileUploadError,
  FileStorageMalformedKeyError,
  FileStorageNotFoundError,
  FileStorageTransientError,
} from '@/modules/content/domain/errors/file-upload.error';
import { S3FileStorageAdapter } from './s3-file-storage.adapter';

/**
 * Hand-written in-memory fake for the AWS S3 client (no auto-mock, no
 * `aws-sdk-client-mock` dep). It records every command and delegates to a
 * per-test handler that returns a canned response or throws an S3-shaped
 * error. Cast to `S3Client` so the adapter accepts it.
 */
class FakeS3Client {
  public readonly sent: object[] = [];
  constructor(private readonly handler: (cmd: object) => unknown) {}
  send(cmd: object): Promise<unknown> {
    this.sent.push(cmd);
    try {
      return Promise.resolve(this.handler(cmd));
    } catch (err) {
      return Promise.reject(err);
    }
  }
}

const s3Error = (name: string, status?: number): Error => {
  const err = new Error(name);
  err.name = name;
  if (status !== undefined) {
    (err as { $metadata?: { httpStatusCode: number } }).$metadata = {
      httpStatusCode: status,
    };
  }
  return err;
};

const KEY = 'a0b1c2d3-0000-0000-0000-000000000099/2026-05/file.jpg';

const adapterWith = (handler: (cmd: object) => unknown) => {
  const fake = new FakeS3Client(handler);
  const adapter = new S3FileStorageAdapter(
    {
      bucket: 'shyraq-media',
      region: 'us-east-1',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      endpoint: 'https://object.pscloud.io',
    },
    fake as unknown as S3Client,
  );
  return { adapter, fake };
};

describe('S3FileStorageAdapter', () => {
  describe('upload', () => {
    it('puts the object and returns the MediaController-proxied url', async () => {
      const { adapter, fake } = adapterWith(() => ({}));
      const result = await adapter.upload({
        buffer: Buffer.from('hello'),
        key: KEY,
        contentType: 'image/jpeg',
      });

      expect(result).toEqual({
        url: `/api/v1/media/${KEY}`,
        key: KEY,
        bytes: 5,
      });
      const cmd = fake.sent[0] as PutObjectCommand;
      expect(cmd).toBeInstanceOf(PutObjectCommand);
      expect(cmd.input).toMatchObject({
        Bucket: 'shyraq-media',
        Key: KEY,
        ContentType: 'image/jpeg',
      });
    });

    it('throws file_too_large before sending when buffer exceeds maxBytes', async () => {
      const { adapter, fake } = adapterWith(() => ({}));
      await expect(
        adapter.upload({
          buffer: Buffer.alloc(11),
          key: KEY,
          contentType: 'image/jpeg',
          maxBytes: 10,
        }),
      ).rejects.toBeInstanceOf(FileUploadError);
      expect(fake.sent).toHaveLength(0);
    });

    it('throws FileStorageMalformedKeyError on a path-traversal key', async () => {
      const { adapter, fake } = adapterWith(() => ({}));
      await expect(
        adapter.upload({
          buffer: Buffer.from('x'),
          key: 'kg/../secret.jpg',
          contentType: 'image/jpeg',
        }),
      ).rejects.toBeInstanceOf(FileStorageMalformedKeyError);
      expect(fake.sent).toHaveLength(0);
    });

    it('maps a 5xx put failure to FileStorageTransientError', async () => {
      const { adapter } = adapterWith(() => {
        throw s3Error('InternalError', 503);
      });
      await expect(
        adapter.upload({
          buffer: Buffer.from('x'),
          key: KEY,
          contentType: 'image/jpeg',
        }),
      ).rejects.toBeInstanceOf(FileStorageTransientError);
    });

    it('maps a non-5xx put failure to FileUploadError(upload_failed)', async () => {
      const { adapter } = adapterWith(() => {
        throw s3Error('AccessDenied', 403);
      });
      await expect(
        adapter.upload({
          buffer: Buffer.from('x'),
          key: KEY,
          contentType: 'image/jpeg',
        }),
      ).rejects.toBeInstanceOf(FileUploadError);
    });
  });

  describe('download', () => {
    it('returns the object bytes as a Buffer', async () => {
      const { adapter, fake } = adapterWith((cmd) => {
        expect(cmd).toBeInstanceOf(GetObjectCommand);
        return {
          Body: {
            transformToByteArray: () =>
              Promise.resolve(new Uint8Array([1, 2, 3])),
          },
        };
      });
      const buf = await adapter.download(KEY);
      expect(buf).toEqual(Buffer.from([1, 2, 3]));
      expect(fake.sent[0]).toBeInstanceOf(GetObjectCommand);
    });

    it('maps NoSuchKey to FileStorageNotFoundError', async () => {
      const { adapter } = adapterWith(() => {
        throw s3Error('NoSuchKey', 404);
      });
      await expect(adapter.download(KEY)).rejects.toBeInstanceOf(
        FileStorageNotFoundError,
      );
    });

    it('maps a 500 to FileStorageTransientError', async () => {
      const { adapter } = adapterWith(() => {
        throw s3Error('InternalError', 500);
      });
      await expect(adapter.download(KEY)).rejects.toBeInstanceOf(
        FileStorageTransientError,
      );
    });

    it('treats a network error (no http status) as transient', async () => {
      const { adapter } = adapterWith(() => {
        throw s3Error('TimeoutError');
      });
      await expect(adapter.download(KEY)).rejects.toBeInstanceOf(
        FileStorageTransientError,
      );
    });
  });

  describe('delete', () => {
    it('sends DeleteObjectCommand', async () => {
      const { adapter, fake } = adapterWith(() => ({}));
      await adapter.delete(KEY);
      expect(fake.sent[0]).toBeInstanceOf(DeleteObjectCommand);
    });

    it('is a no-op when the object is already gone (404)', async () => {
      const { adapter } = adapterWith(() => {
        throw s3Error('NoSuchKey', 404);
      });
      await expect(adapter.delete(KEY)).resolves.toBeUndefined();
    });

    it('surfaces a transient error so the cleanup cron can retry', async () => {
      const { adapter } = adapterWith(() => {
        throw s3Error('ServiceUnavailable', 503);
      });
      await expect(adapter.delete(KEY)).rejects.toBeInstanceOf(
        FileStorageTransientError,
      );
    });
  });

  describe('getSignedUrl', () => {
    it('returns a presigned GET url carrying the key and a signature', async () => {
      // Real client (no network — presign is local crypto over the config).
      const adapter = new S3FileStorageAdapter({
        bucket: 'shyraq-media',
        region: 'us-east-1',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        endpoint: 'https://object.pscloud.io',
      });
      const url = await adapter.getSignedUrl(KEY, 60);
      expect(url).toContain('shyraq-media');
      expect(url).toContain('X-Amz-Signature');
      expect(url).toContain('X-Amz-Expires=60');
    });

    it('rejects a malformed key before presigning', async () => {
      const { adapter } = adapterWith(() => ({}));
      await expect(adapter.getSignedUrl('kg/../x.jpg')).rejects.toBeInstanceOf(
        FileStorageMalformedKeyError,
      );
    });
  });
});
