import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileUploadError } from '@/modules/content/domain/errors/file-upload.error';
import { LocalFileStorageAdapter } from './local-file-storage.adapter';

/**
 * B22a T8 — `assertSafeKey` decode-then-validate regression coverage
 * (FINDINGS B17 MEDIUM#5).
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

  it('throws on a literal `..` segment', () => {
    expect(call('foo/../bar.jpg')).toThrow(FileUploadError);
  });

  it('throws on a percent-encoded `..` (`%2E%2E/foo`)', () => {
    // Pre-fix this slipped through — the raw substring check saw `%2E%2E`
    // (no literal `..`). After decode this becomes `../foo`.
    expect(call('%2E%2E/foo.jpg')).toThrow(FileUploadError);
  });

  it('throws on a percent-encoded slash + dotdot (`%2E%2E%2F`)', () => {
    // Both the dots AND the path separator are percent-encoded.
    expect(call('safe/%2E%2E%2Fescape.jpg')).toThrow(FileUploadError);
  });

  it('throws on an absolute path', () => {
    expect(call('/abs/path.jpg')).toThrow(FileUploadError);
  });

  it('throws on a backslash separator', () => {
    expect(call('foo\\bar.jpg')).toThrow(FileUploadError);
  });

  it('throws on a NUL byte (null-truncation defence)', () => {
    expect(call('safe.jpg\0extra')).toThrow(FileUploadError);
  });

  it('throws on a malformed percent-escape', () => {
    // `%FF%FF` is structurally valid bytes but `decodeURIComponent`
    // raises URIError because the byte sequence is not valid UTF-8.
    expect(call('%FF%FF')).toThrow(FileUploadError);
  });

  it('throws on empty key', () => {
    expect(call('')).toThrow(FileUploadError);
  });
});
