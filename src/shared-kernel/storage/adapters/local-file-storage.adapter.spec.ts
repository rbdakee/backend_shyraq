import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileUploadError,
  FileStorageMalformedKeyError,
  FileStorageNotFoundError,
} from '@/modules/content/domain/errors/file-upload.error';
import { LocalFileStorageAdapter } from './local-file-storage.adapter';

/**
 * B22a T8 — `assertSafeKey` decode-then-validate regression coverage
 * (FINDINGS B17 MEDIUM#5).
 *
 * B22b T9 — updated to assert the discriminated error variants introduced
 * in the storage-error-discrimination sweep:
 *   - Empty key → `FileUploadError('media_url_required')`
 *   - Path traversal / percent-encoded `..` / absolute path → `FileStorageMalformedKeyError`
 *   - Malformed percent-escape (`%FF%FF`) → `FileStorageMalformedKeyError`
 *
 * The adapter's `assertSafeKey` is private; we exercise it via the public
 * `getSignedUrl` entry point — it short-circuits before any disk I/O so
 * we don't need a populated uploads dir for the negative cases.
 */
describe('LocalFileStorageAdapter.assertSafeKey', () => {
  let adapter: LocalFileStorageAdapter;
  let uploads: string;

  beforeAll(async () => {
    uploads = await fs.mkdtemp(join(tmpdir(), 'shyraq-storage-'));
    adapter = new LocalFileStorageAdapter({ uploadsDir: uploads });
  });

  afterAll(async () => {
    await fs.rm(uploads, { recursive: true, force: true });
  });

  // `getSignedUrl` is sync-throwing (assertSafeKey runs before the
  // returned Promise is constructed), so we wrap each call in a thunk
  // and use `.toThrow` rather than `.rejects`.
  const call = (key: string) => () => adapter.getSignedUrl(key);

  it('accepts a well-formed server-side key', async () => {
    await expect(
      adapter.getSignedUrl(
        'kg/2026-05/00000000-0000-0000-0000-000000000000.jpg',
      ),
    ).resolves.toMatch(/\/api\/v1\/media\//);
  });

  it('throws FileStorageMalformedKeyError on a literal `..` segment', () => {
    expect(call('foo/../bar.jpg')).toThrow(FileStorageMalformedKeyError);
  });

  it('throws FileStorageMalformedKeyError on a percent-encoded `..` (`%2E%2E/foo`)', () => {
    // Pre-fix this slipped through — the raw substring check saw `%2E%2E`
    // (no literal `..`). After decode this becomes `../foo`.
    expect(call('%2E%2E/foo.jpg')).toThrow(FileStorageMalformedKeyError);
  });

  it('throws FileStorageMalformedKeyError on a percent-encoded slash + dotdot (`%2E%2E%2F`)', () => {
    // Both the dots AND the path separator are percent-encoded.
    expect(call('safe/%2E%2E%2Fescape.jpg')).toThrow(
      FileStorageMalformedKeyError,
    );
  });

  it('throws FileStorageMalformedKeyError on an absolute path', () => {
    expect(call('/abs/path.jpg')).toThrow(FileStorageMalformedKeyError);
  });

  it('throws FileStorageMalformedKeyError on a backslash separator', () => {
    expect(call('foo\\bar.jpg')).toThrow(FileStorageMalformedKeyError);
  });

  it('throws FileStorageMalformedKeyError on a NUL byte (null-truncation defence)', () => {
    expect(call('safe.jpg\0extra')).toThrow(FileStorageMalformedKeyError);
  });

  it('throws FileStorageMalformedKeyError on a malformed percent-escape', () => {
    // `%FF%FF` is structurally valid bytes but `decodeURIComponent`
    // raises URIError because the byte sequence is not valid UTF-8.
    expect(call('%FF%FF')).toThrow(FileStorageMalformedKeyError);
  });

  it('throws FileUploadError(media_url_required) on empty key', () => {
    expect(call('')).toThrow(FileUploadError);
  });
});

describe('LocalFileStorageAdapter.download — FileStorageNotFoundError', () => {
  let adapter: LocalFileStorageAdapter;
  let uploads: string;

  beforeAll(async () => {
    uploads = await fs.mkdtemp(join(tmpdir(), 'shyraq-storage-dl-'));
    adapter = new LocalFileStorageAdapter({ uploadsDir: uploads });
  });

  afterAll(async () => {
    await fs.rm(uploads, { recursive: true, force: true });
  });

  it('throws FileStorageNotFoundError when key does not exist', async () => {
    await expect(
      adapter.download('kg/2026-05/nonexistent.jpg'),
    ).rejects.toBeInstanceOf(FileStorageNotFoundError);
  });

  it('resolves with file bytes for an existing key', async () => {
    const key = 'kg/2026-05/existing-test.jpg';
    const fullPath = join(uploads, key);
    await fs.mkdir(join(uploads, 'kg/2026-05'), { recursive: true });
    await fs.writeFile(fullPath, Buffer.from('test-bytes'));
    await expect(adapter.download(key)).resolves.toEqual(
      Buffer.from('test-bytes'),
    );
  });
});
