import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { MediaController } from './media.controller';

// FINDINGS.md SP5 — regression coverage for the authed media route that
// replaces ServeStaticModule. Verifies the three gates: kg path-match,
// path-shape validation, and 404 on missing file.

const KG_A = '11111111-1111-1111-1111-111111111111';
const KG_B = '22222222-2222-2222-2222-222222222222';
const VALID_FILENAME = '33333333-3333-3333-3333-333333333333.jpg';
const VALID_YYYY_MM = '2026-05';

function makeRes(): Response & {
  capturedStatus: number;
  capturedBody: Buffer | null;
  capturedHeaders: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  let status = 0;
  let body: Buffer | null = null;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    send(buf: Buffer) {
      body = buf;
      return this;
    },
    get capturedStatus() {
      return status;
    },
    get capturedBody() {
      return body;
    },
    get capturedHeaders() {
      return headers;
    },
  };
  return res as unknown as Response & {
    capturedStatus: number;
    capturedBody: Buffer | null;
    capturedHeaders: Record<string, string>;
  };
}

class FakeStorage extends FileStoragePort {
  store = new Map<string, Buffer>();

  upload(): Promise<never> {
    throw new Error('not used');
  }
  download(key: string): Promise<Buffer> {
    const buf = this.store.get(key);
    if (!buf) {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      return Promise.reject(err);
    }
    return Promise.resolve(buf);
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  getSignedUrl(): Promise<string> {
    return Promise.resolve('');
  }
}

describe('MediaController (FINDINGS.md SP5)', () => {
  const setup = () => {
    const storage = new FakeStorage();
    return { ctrl: new MediaController(storage), storage };
  };
  const tenantOf = (kgId: string | null, bypass = false): TenantContext => ({
    kgId,
    bypass,
  });

  it('streams the file when kg matches and key is well-formed', async () => {
    const { ctrl, storage } = setup();
    const buf = Buffer.from([0xff, 0xd8, 0xff]);
    storage.store.set(`${KG_A}/${VALID_YYYY_MM}/${VALID_FILENAME}`, buf);
    const res = makeRes();
    await ctrl.stream(tenantOf(KG_A), KG_A, VALID_YYYY_MM, VALID_FILENAME, res);
    expect(res.capturedStatus).toBe(200);
    expect(res.capturedBody).toEqual(buf);
    expect(res.capturedHeaders['Content-Type']).toBe('image/jpeg');
    expect(res.capturedHeaders['Cache-Control']).toContain('no-store');
  });

  it('throws 403 when caller kg differs from path kg', async () => {
    const { ctrl } = setup();
    await expect(
      ctrl.stream(
        tenantOf(KG_B),
        KG_A,
        VALID_YYYY_MM,
        VALID_FILENAME,
        makeRes(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows super-admin (bypass=true) to fetch any kg media', async () => {
    const { ctrl, storage } = setup();
    storage.store.set(
      `${KG_A}/${VALID_YYYY_MM}/${VALID_FILENAME}`,
      Buffer.from([0]),
    );
    const res = makeRes();
    await ctrl.stream(
      tenantOf(null, true),
      KG_A,
      VALID_YYYY_MM,
      VALID_FILENAME,
      res,
    );
    expect(res.capturedStatus).toBe(200);
  });

  it('throws 404 on malformed kgId / yyyyMm / filename (path-shape guard)', async () => {
    const { ctrl } = setup();
    await expect(
      ctrl.stream(
        tenantOf(KG_A),
        'not-a-uuid',
        VALID_YYYY_MM,
        VALID_FILENAME,
        makeRes(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      ctrl.stream(tenantOf(KG_A), KG_A, '2026-13', VALID_FILENAME, makeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      ctrl.stream(
        tenantOf(KG_A),
        KG_A,
        VALID_YYYY_MM,
        '../etc/passwd',
        makeRes(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps storage ENOENT to 404', async () => {
    const { ctrl } = setup();
    await expect(
      ctrl.stream(
        tenantOf(KG_A),
        KG_A,
        VALID_YYYY_MM,
        VALID_FILENAME,
        makeRes(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
