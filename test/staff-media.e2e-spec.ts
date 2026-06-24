/**
 * BR-012 — Generic staff media upload (e2e)
 *
 * Endpoint under test:
 *   POST /api/v1/staff/media   (multipart/form-data, field `file`)
 *
 * Scenarios:
 *   A. Mentor uploads valid PNG → 200 { url, key, bytes };
 *      url begins with /api/v1/media/<kgId>/ ; key is kg-scoped.
 *   B. Empty / missing file → 400 media_file_required.
 *   C. Unsupported MIME (application/pdf) → 400 media_type_invalid.
 *   D. File > 10 MB → 400 media_too_large.
 *   E. Parent token (no staff role) → 403.
 *
 * Roles allowed: mentor, specialist, reception, admin.
 * Key shape is kg-scoped (derived from the token tenant), so no cross-tenant
 * scenario is needed.
 */
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-staff-media@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

// Mirror of the controller constant (10 MB cap for staff image uploads).
const STAFF_MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// ── minimal 1×1 RGBA PNG buffer (68 bytes) ──────────────────────────────────
// Single contiguous hex string — spaces inside the hex would cause
// `Buffer.from(..., 'hex')` to silently truncate at the first non-hex pair.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082',
  'hex',
);

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('BR-012 Staff Media Upload (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;

  // ── auth helpers ───────────────────────────────────────────────────────────

  async function mintToken(opts: {
    sub: string;
    role: string;
    kindergartenId: string;
  }): Promise<string> {
    return jwtService.signAsync(
      {
        sub: opts.sub,
        role: opts.role,
        kindergarten_id: opts.kindergartenId,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function seedSuperAdmin(): Promise<void> {
    const id = randomUUID();
    const hash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 4);
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO saas_users (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'SA', $3, 'super_admin', true)`,
        [id, SUPER_ADMIN_EMAIL, hash],
      );
    });
  }

  async function loginSuperAdmin(): Promise<string> {
    const res = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({ email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD })
      .expect(200);
    return res.body.access_token as string;
  }

  async function createKgWithAdmin(
    slug: string,
    phone: string,
  ): Promise<{
    kgId: string;
    userId: string;
    staffMemberId: string;
    adminToken: string;
  }> {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: `Staff-Media KG ${slug}`,
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await mintToken({
      sub: body.user.id,
      role: 'admin',
      kindergartenId: body.kindergarten.id,
    });
    return {
      kgId: body.kindergarten.id,
      userId: body.user.id,
      staffMemberId: body.staff_member.id,
      adminToken,
    };
  }

  async function seedUser(phone: string): Promise<string> {
    const id = randomUUID();
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, '')`,
        [id, phone],
      );
    });
    return id;
  }

  async function seedStaffMember(
    kgId: string,
    userId: string,
    role: string,
  ): Promise<string> {
    const staffId = randomUUID();
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [staffId, kgId, userId, role],
      );
    });
    return staffId;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.server;
    const config = ctx.app.get(ConfigService);
    jwtSecret = config.getOrThrow<string>('auth.jwtAccessSecret');
    jwtService = ctx.app.get(JwtService);
  });

  afterAll(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    await ctx.app.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario A — Mentor uploads valid PNG
  // ════════════════════════════════════════════════════════════════════════════

  it('returns 200 with kg-scoped { url, key, bytes } for a valid PNG upload by a mentor', async () => {
    const { kgId, adminToken } = await createKgWithAdmin(
      'smedia-a',
      '+77050300001',
    );

    // Seed a dedicated mentor in this kg.
    const mentorUserId = await seedUser('+77050300002');
    await seedStaffMember(kgId, mentorUserId, 'mentor');
    const mentorToken = await mintToken({
      sub: mentorUserId,
      role: 'mentor',
      kindergartenId: kgId,
    });

    const res = await request(server)
      .post('/api/v1/staff/media')
      .set('Authorization', `Bearer ${mentorToken}`)
      .attach('file', TINY_PNG, {
        filename: 'photo.png',
        contentType: 'image/png',
      })
      .expect(200);

    const url = res.body.url as string;
    const key = res.body.key as string;
    expect(url).toMatch(/^\/api\/v1\/media\//);
    // Key is kg-scoped: <kgId>/<yyyy-mm>/<uuid>.png — url is the canonical
    // /api/v1/media/<key> form (NOT presigned, thanks to @SkipMediaSign).
    expect(url).toBe(`/api/v1/media/${key}`);
    expect(url.startsWith(`/api/v1/media/${kgId}/`)).toBe(true);
    expect(key.startsWith(`${kgId}/`)).toBe(true);
    expect(key).toMatch(/\.png$/);
    expect(res.body.bytes).toBe(TINY_PNG.length);

    void adminToken;
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario B — Missing / empty file → 400 media_file_required
  // ════════════════════════════════════════════════════════════════════════════

  it('rejects a request with no file → 400 media_file_required', async () => {
    const { kgId, adminToken } = await createKgWithAdmin(
      'smedia-b',
      '+77050300011',
    );

    const res = await request(server)
      .post('/api/v1/staff/media')
      .set('Authorization', `Bearer ${adminToken}`)
      // No .attach() — multipart with zero files.
      .field('noop', 'x')
      .expect(400);

    expect(res.body.error_code ?? res.body.message).toMatch(
      /media_file_required/,
    );
    void kgId;
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario C — Unsupported MIME → 400 media_type_invalid
  // ════════════════════════════════════════════════════════════════════════════

  it('rejects a non-image (application/pdf) upload → 400 media_type_invalid', async () => {
    const { adminToken } = await createKgWithAdmin('smedia-c', '+77050300021');

    const res = await request(server)
      .post('/api/v1/staff/media')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('%PDF-1.4 fake pdf bytes'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);

    expect(res.body.error_code ?? res.body.message).toMatch(
      /media_type_invalid/,
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario D — File > 10 MB → 400 media_too_large
  // ════════════════════════════════════════════════════════════════════════════

  it('rejects an image larger than 10 MB → media_too_large (400) or 413', async () => {
    const { adminToken } = await createKgWithAdmin('smedia-d', '+77050300031');

    // 10 MB + 1 byte of zero-padded "image" bytes. The multer `limits.fileSize`
    // is set to exactly 10 MB. Multer aborts the stream once the cap is
    // exceeded and Nest's multer module maps `LIMIT_FILE_SIZE` to a 413
    // PayloadTooLargeException. The controller's explicit
    // `BadRequestException('media_too_large')` (400) is the defence-in-depth
    // backstop reached only if multer did NOT pre-abort. Either way the upload
    // is rejected — assert the union so the test is robust to the multer path.
    const oversized = Buffer.alloc(STAFF_MEDIA_MAX_BYTES + 1, 0);

    const res = await request(server)
      .post('/api/v1/staff/media')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', oversized, {
        filename: 'huge.png',
        contentType: 'image/png',
      });

    expect([400, 413]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body.error_code ?? res.body.message).toMatch(
        /media_too_large/,
      );
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario E — Parent token (no staff role) → 403
  // ════════════════════════════════════════════════════════════════════════════

  it('rejects a parent-role token (no staff role) → 403', async () => {
    const { kgId } = await createKgWithAdmin('smedia-e', '+77050300041');

    const parentUserId = await seedUser('+77050300042');
    const parentToken = await mintToken({
      sub: parentUserId,
      role: 'parent',
      kindergartenId: kgId,
    });

    await request(server)
      .post('/api/v1/staff/media')
      .set('Authorization', `Bearer ${parentToken}`)
      .attach('file', TINY_PNG, {
        filename: 'photo.png',
        contentType: 'image/png',
      })
      .expect(403);
  });
});
