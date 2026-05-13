/**
 * B18 Diagnostics & Progress (e2e) — Scenarios A–K
 *
 * Endpoints under test:
 *   Admin:
 *     GET    /api/v1/admin/diagnostic-templates
 *     POST   /api/v1/admin/diagnostic-templates
 *     GET    /api/v1/admin/diagnostic-templates/:id
 *     PATCH  /api/v1/admin/diagnostic-templates/:id
 *     POST   /api/v1/admin/diagnostic-templates/:id/deactivate
 *   Staff (admin | specialist):
 *     GET    /api/v1/staff/diagnostic-entries
 *     POST   /api/v1/staff/diagnostic-entries
 *     GET    /api/v1/staff/diagnostic-entries/:id
 *     PATCH  /api/v1/staff/diagnostic-entries/:id
 *   Staff (admin | mentor):
 *     GET    /api/v1/staff/progress-notes
 *     POST   /api/v1/staff/progress-notes
 *     PATCH  /api/v1/staff/progress-notes/:id
 *     DELETE /api/v1/staff/progress-notes/:id
 *   Staff (admin | specialist):
 *     GET    /api/v1/staff/my-todos
 *   Parent:
 *     GET    /api/v1/parent/children/:childId/diagnostics
 *     GET    /api/v1/parent/children/:childId/diagnostics/:entryId
 *     GET    /api/v1/parent/children/:childId/progress-notes
 *
 * Scenarios:
 *   A. Template CRUD (admin)
 *   B. Template create with invalid schema → 400
 *   C. Diagnostic entry create (specialist) — happy path + validation
 *   D. Diagnostic entry create with invalid data → 400
 *   E. Author-only PATCH on diagnostic entry
 *   F. Progress note CRUD (mentor)
 *   G. Author-only progress note PATCH/DELETE
 *   H. My-todos 6-month staleness algorithm
 *   I. Parent reads diagnostics
 *   J. Nanny 403 on diagnostics
 *   K. Cross-tenant phantom (RLS isolation)
 */
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-diag@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

// ── date helpers ──────────────────────────────────────────────────────────────

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoPast(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoFuture(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── shared template schema builder ────────────────────────────────────────────

function validSchema(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sections: [
      {
        title: 'General',
        fields: [
          { key: 'notes', label: 'Notes', type: 'text', required: true },
          {
            key: 'score',
            label: 'Score',
            type: 'scale',
            required: true,
            min: 1,
            max: 10,
          },
          {
            key: 'category',
            label: 'Category',
            type: 'select',
            required: false,
            options: ['low', 'medium', 'high'],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function validEntryData(): Record<string, unknown> {
  return {
    notes: 'Good progress',
    score: 7,
    category: 'medium',
  };
}

describe('B18 Diagnostics & Progress (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;

  // ── auth helpers ─────────────────────────────────────────────────────────────

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
    const hash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 4);
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO saas_users (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'SA', $3, 'super_admin', true)`,
        [randomUUID(), SUPER_ADMIN_EMAIL, hash],
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

  /**
   * Create a kindergarten via the SaaS endpoint. Returns kgId, the seeded
   * admin user id, their staff_member id, and a minted admin JWT.
   */
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
        name: `Diag-Test KG ${slug}`,
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

  /** Seed a new user row and return their id. */
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

  /**
   * Seed a staff_member row for an existing user with a given role.
   * `specialistType` maps to `staff_members.specialist_type`.
   */
  async function seedStaffMember(
    kgId: string,
    userId: string,
    role: string,
    specialistType?: string,
  ): Promise<string> {
    const staffId = randomUUID();
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO staff_members (id, kindergarten_id, user_id, role, specialist_type, is_active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [staffId, kgId, userId, role, specialistType ?? null],
      );
    });
    return staffId;
  }

  /** Seed an approved guardian row directly via SQL (bypass_rls). */
  async function seedApprovedGuardian(
    kgId: string,
    childId: string,
    userId: string,
    role: 'primary' | 'secondary' | 'nanny' = 'primary',
    permissionsOverride?: Record<string, boolean>,
  ): Promise<void> {
    const hasApprovalRights = role === 'primary';
    // Build the permissions jsonb: for nanny we persist an explicit override
    // so the domain `effective()` method reads view_diagnostics=false from
    // the override bag, not just from the role default.  For nanny the
    // defaults already return false, but we include the override bag to be
    // explicit and to mirror how the real invite flow stores permissions.
    const permsParam = permissionsOverride
      ? JSON.stringify(permissionsOverride)
      : '{}';
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO child_guardians
           (id, kindergarten_id, child_id, user_id, role, status,
            can_pickup, has_approval_rights, permissions, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, $5, 'approved', true, $6, $7::jsonb, $4, now())`,
        [
          randomUUID(),
          kgId,
          childId,
          userId,
          role,
          hasApprovalRights,
          permsParam,
        ],
      );
    });
  }

  /** Create a child via the admin endpoint and return its id. */
  async function createChild(
    adminToken: string,
    opts: { full_name?: string; date_of_birth?: string } = {},
  ): Promise<string> {
    const res = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        full_name: opts.full_name ?? 'Test Child',
        date_of_birth: opts.date_of_birth ?? '2020-06-15',
      })
      .expect(201);
    return res.body.id as string;
  }

  /**
   * Admin POST /admin/diagnostic-templates and return the created body.
   */
  async function createTemplate(
    adminToken: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; version: number; is_active: boolean }> {
    const res = await request(server)
      .post('/api/v1/admin/diagnostic-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        specialist_type: 'psychologist',
        name: 'Test Template',
        schema: validSchema(),
        ...overrides,
      })
      .expect(201);
    return res.body as { id: string; version: number; is_active: boolean };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

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

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario A — Template CRUD (admin)
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario A: Template CRUD (admin)', () => {
    it(
      'creates template (version=1, is_active=true), lists it, gets detail, ' +
        'patches name-only (version stays 1), patches schema (version bumps to 2), ' +
        'deactivates, filtered list excludes deactivated template',
      async () => {
        const { adminToken } = await createKgWithAdmin('tpl-a', '+77010100001');

        // POST — create
        const created = await createTemplate(adminToken);
        const id = created.id;
        expect(id).toBeDefined();
        expect(created.version).toBe(1);
        expect(created.is_active).toBe(true);

        // GET list — contains template
        const listRes = await request(server)
          .get('/api/v1/admin/diagnostic-templates')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(
          (listRes.body.items as Array<{ id: string }>).some(
            (t) => t.id === id,
          ),
        ).toBe(true);

        // GET detail
        const detailRes = await request(server)
          .get(`/api/v1/admin/diagnostic-templates/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(detailRes.body.id).toBe(id);
        expect(detailRes.body.specialist_type).toBe('psychologist');
        expect(detailRes.body.version).toBe(1);

        // PATCH name only — version must remain 1
        const patchNameRes = await request(server)
          .patch(`/api/v1/admin/diagnostic-templates/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ name: 'Updated Name' })
          .expect(200);
        expect(patchNameRes.body.name).toBe('Updated Name');
        expect(patchNameRes.body.version).toBe(1);

        // PATCH schema (different shape) — version bumps to 2
        const newSchema = validSchema({
          sections: [
            {
              title: 'New Section',
              fields: [
                {
                  key: 'rating',
                  label: 'Rating',
                  type: 'scale',
                  required: true,
                  min: 1,
                  max: 5,
                },
              ],
            },
          ],
        });
        const patchSchemaRes = await request(server)
          .patch(`/api/v1/admin/diagnostic-templates/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ schema: newSchema })
          .expect(200);
        expect(patchSchemaRes.body.version).toBe(2);

        // POST :id/deactivate
        const deactivateRes = await request(server)
          .post(`/api/v1/admin/diagnostic-templates/${id}/deactivate`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(deactivateRes.body.is_active).toBe(false);

        // GET ?is_active=true → does NOT contain deactivated template
        const activeListRes = await request(server)
          .get('/api/v1/admin/diagnostic-templates?is_active=true')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(
          (activeListRes.body.items as Array<{ id: string }>).some(
            (t) => t.id === id,
          ),
        ).toBe(false);

        // Regression (T6-H1): GET without ?is_active filter MUST include the
        // deactivated template. The previous transform `value === 'true'`
        // collapsed an omitted query param to `false`, silently filtering to
        // inactive-only. Now `undefined` survives the transform and the
        // service treats it as "no filter".
        const allListRes = await request(server)
          .get('/api/v1/admin/diagnostic-templates')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(
          (allListRes.body.items as Array<{ id: string }>).some(
            (t) => t.id === id,
          ),
        ).toBe(true);
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario B — Template create with invalid schema → 400
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario B: Template create with invalid schema → 400', () => {
    it('rejects schema missing sections → 400 diagnostic_template_schema_invalid', async () => {
      const { adminToken } = await createKgWithAdmin('tpl-b1', '+77010100011');

      const res = await request(server)
        .post('/api/v1/admin/diagnostic-templates')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          specialist_type: 'psychologist',
          name: 'Bad Template',
          schema: { notSections: [] },
        })
        .expect(400);

      expect(res.body.message ?? res.body.error).toMatch(
        /diagnostic_template_schema_invalid/,
      );
    });

    it('rejects select field missing options → 400 diagnostic_template_schema_invalid', async () => {
      const { adminToken } = await createKgWithAdmin('tpl-b2', '+77010100012');

      const schemaNoOptions = {
        sections: [
          {
            title: 'Test',
            fields: [
              {
                key: 'mood',
                label: 'Mood',
                type: 'select',
                required: false,
                // options intentionally omitted
              },
            ],
          },
        ],
      };

      const res = await request(server)
        .post('/api/v1/admin/diagnostic-templates')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          specialist_type: 'psychologist',
          name: 'Bad Template',
          schema: schemaNoOptions,
        })
        .expect(400);

      expect(res.body.message ?? res.body.error).toMatch(
        /diagnostic_template_schema_invalid/,
      );
    });

    it('rejects duplicate field keys → 400 diagnostic_template_schema_invalid with details.path', async () => {
      const { adminToken } = await createKgWithAdmin('tpl-b3', '+77010100013');

      const schemaDuplicateKeys = {
        sections: [
          {
            title: 'Test',
            fields: [
              { key: 'notes', label: 'Note 1', type: 'text', required: false },
              { key: 'notes', label: 'Note 2', type: 'text', required: false },
            ],
          },
        ],
      };

      const res = await request(server)
        .post('/api/v1/admin/diagnostic-templates')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          specialist_type: 'psychologist',
          name: 'Bad Template',
          schema: schemaDuplicateKeys,
        })
        .expect(400);

      const body = res.body as Record<string, unknown>;
      expect(body.message ?? body.error).toMatch(
        /diagnostic_template_schema_invalid/,
      );
      // details.path should be set to the offending key path
      const details = body.details as Record<string, unknown> | undefined;
      expect(details?.path).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario C — Diagnostic entry create (specialist) — happy path
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario C: Diagnostic entry create (specialist) — happy path', () => {
    it(
      'specialist creates entry with valid data → 201 with template_name + template_version; ' +
        'GET returns entry',
      async () => {
        const { kgId, userId, staffMemberId, adminToken } =
          await createKgWithAdmin('ent-c', '+77010100021');

        // Create a template as admin
        const template = await createTemplate(adminToken, {
          specialist_type: 'psychologist',
        });

        // Seed a specialist staff_member (different user, same kg)
        const specUserId = await seedUser('+77010100022');
        await seedStaffMember(kgId, specUserId, 'specialist', 'psychologist');
        const specToken = await mintToken({
          sub: specUserId,
          role: 'specialist',
          kindergartenId: kgId,
        });

        const childId = await createChild(adminToken);

        // Specialist POST diagnostic entry
        const entryRes = await request(server)
          .post('/api/v1/staff/diagnostic-entries')
          .set('Authorization', `Bearer ${specToken}`)
          .send({
            child_id: childId,
            template_id: template.id,
            assessment_date: isoToday(),
            data: validEntryData(),
          })
          .expect(201);

        const entryId = entryRes.body.id as string;
        expect(entryId).toBeDefined();
        expect(entryRes.body.template_name).toBeTruthy();
        expect(entryRes.body.template_version).toBe(1);

        // GET entry
        const getRes = await request(server)
          .get(`/api/v1/staff/diagnostic-entries/${entryId}`)
          .set('Authorization', `Bearer ${specToken}`)
          .expect(200);

        expect(getRes.body.id).toBe(entryId);
        expect(getRes.body.template_name).toBeTruthy();
        expect(getRes.body.template_version).toBe(1);

        void userId;
        void staffMemberId;
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario D — Diagnostic entry create with invalid data → 400
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario D: Diagnostic entry create with invalid data → 400', () => {
    it('rejects entry with required field missing → 400 diagnostic_entry_data_invalid', async () => {
      const { kgId, adminToken } = await createKgWithAdmin(
        'ent-d1',
        '+77010100031',
      );
      const template = await createTemplate(adminToken, {
        specialist_type: 'psychologist',
      });
      const specUserId = await seedUser('+77010100032');
      await seedStaffMember(kgId, specUserId, 'specialist', 'psychologist');
      const specToken = await mintToken({
        sub: specUserId,
        role: 'specialist',
        kindergartenId: kgId,
      });
      const childId = await createChild(adminToken);

      // `notes` is required in validSchema() — omit it
      const res = await request(server)
        .post('/api/v1/staff/diagnostic-entries')
        .set('Authorization', `Bearer ${specToken}`)
        .send({
          child_id: childId,
          template_id: template.id,
          assessment_date: isoToday(),
          data: { score: 5 /* notes missing */ },
        })
        .expect(400);

      expect(res.body.message ?? res.body.error).toMatch(
        /diagnostic_entry_data_invalid/,
      );
      const details = res.body.details as Record<string, unknown> | undefined;
      expect(details?.path).toBeDefined();
    });

    it('rejects entry with select value not in options → 400 diagnostic_entry_data_invalid', async () => {
      const { kgId, adminToken } = await createKgWithAdmin(
        'ent-d2',
        '+77010100033',
      );
      const template = await createTemplate(adminToken, {
        specialist_type: 'psychologist',
      });
      const specUserId = await seedUser('+77010100034');
      await seedStaffMember(kgId, specUserId, 'specialist', 'psychologist');
      const specToken = await mintToken({
        sub: specUserId,
        role: 'specialist',
        kindergartenId: kgId,
      });
      const childId = await createChild(adminToken);

      const res = await request(server)
        .post('/api/v1/staff/diagnostic-entries')
        .set('Authorization', `Bearer ${specToken}`)
        .send({
          child_id: childId,
          template_id: template.id,
          assessment_date: isoToday(),
          data: {
            notes: 'Some note',
            score: 5,
            category: 'invalid_option', // not in ['low','medium','high']
          },
        })
        .expect(400);

      expect(res.body.message ?? res.body.error).toMatch(
        /diagnostic_entry_data_invalid/,
      );
    });

    it('rejects entry with assessment_date in the future → 400 assessment_date_in_future', async () => {
      const { kgId, adminToken } = await createKgWithAdmin(
        'ent-d3',
        '+77010100035',
      );
      const template = await createTemplate(adminToken, {
        specialist_type: 'psychologist',
      });
      const specUserId = await seedUser('+77010100036');
      await seedStaffMember(kgId, specUserId, 'specialist', 'psychologist');
      const specToken = await mintToken({
        sub: specUserId,
        role: 'specialist',
        kindergartenId: kgId,
      });
      const childId = await createChild(adminToken);

      const res = await request(server)
        .post('/api/v1/staff/diagnostic-entries')
        .set('Authorization', `Bearer ${specToken}`)
        .send({
          child_id: childId,
          template_id: template.id,
          assessment_date: isoFuture(5),
          data: validEntryData(),
        })
        .expect(400);

      const msg = (res.body.message ?? res.body.error) as string;
      expect(msg).toMatch(/assessment_date_in_future/);
    });

    it('rejects entry against a deactivated template → 409 diagnostic_template_inactive', async () => {
      const { kgId, adminToken } = await createKgWithAdmin(
        'ent-d4',
        '+77010100037',
      );
      const template = await createTemplate(adminToken, {
        specialist_type: 'psychologist',
      });

      // Deactivate the template
      await request(server)
        .post(`/api/v1/admin/diagnostic-templates/${template.id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const specUserId = await seedUser('+77010100038');
      await seedStaffMember(kgId, specUserId, 'specialist', 'psychologist');
      const specToken = await mintToken({
        sub: specUserId,
        role: 'specialist',
        kindergartenId: kgId,
      });
      const childId = await createChild(adminToken);

      const res = await request(server)
        .post('/api/v1/staff/diagnostic-entries')
        .set('Authorization', `Bearer ${specToken}`)
        .send({
          child_id: childId,
          template_id: template.id,
          assessment_date: isoToday(),
          data: validEntryData(),
        })
        .expect(409);

      expect(res.body.message ?? res.body.error).toMatch(
        /diagnostic_template_inactive/,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario E — Author-only PATCH on diagnostic entry
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario E: Author-only PATCH on diagnostic entry', () => {
    it(
      'specialist A creates entry; ' +
        'specialist B PATCH → 403 diagnostic_entry_not_authored_by_you; ' +
        'specialist A PATCH → 200; ' +
        'admin PATCH → 200 (admin bypass pre-fetches specialist_id)',
      async () => {
        const {
          kgId,
          userId: adminUserId,
          adminToken,
        } = await createKgWithAdmin('ent-e', '+77010100041');
        const template = await createTemplate(adminToken, {
          specialist_type: 'psychologist',
        });
        const childId = await createChild(adminToken);

        // Specialist A
        const specAUserId = await seedUser('+77010100042');
        await seedStaffMember(kgId, specAUserId, 'specialist', 'psychologist');
        const specAToken = await mintToken({
          sub: specAUserId,
          role: 'specialist',
          kindergartenId: kgId,
        });

        // Specialist B (different user, same kg)
        const specBUserId = await seedUser('+77010100043');
        await seedStaffMember(kgId, specBUserId, 'specialist', 'psychologist');
        const specBToken = await mintToken({
          sub: specBUserId,
          role: 'specialist',
          kindergartenId: kgId,
        });

        // Specialist A creates entry
        const createRes = await request(server)
          .post('/api/v1/staff/diagnostic-entries')
          .set('Authorization', `Bearer ${specAToken}`)
          .send({
            child_id: childId,
            template_id: template.id,
            assessment_date: isoToday(),
            data: validEntryData(),
          })
          .expect(201);
        const entryId = createRes.body.id as string;

        // Specialist B PATCH → 403
        const rejectRes = await request(server)
          .patch(`/api/v1/staff/diagnostic-entries/${entryId}`)
          .set('Authorization', `Bearer ${specBToken}`)
          .send({ summary: 'Trying to hijack' })
          .expect(403);

        expect(rejectRes.body.message ?? rejectRes.body.error).toMatch(
          /diagnostic_entry_not_authored_by_you/,
        );

        // Specialist A PATCH → 200
        const aPatchRes = await request(server)
          .patch(`/api/v1/staff/diagnostic-entries/${entryId}`)
          .set('Authorization', `Bearer ${specAToken}`)
          .send({ summary: 'Updated by author' })
          .expect(200);
        expect(aPatchRes.body.summary).toBe('Updated by author');

        // Admin PATCH → 200 (controller pre-fetches entry.specialistId and
        // passes it as callerStaffMemberId — bypassing the author check)
        const adminPatchRes = await request(server)
          .patch(`/api/v1/staff/diagnostic-entries/${entryId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ summary: 'Admin override' })
          .expect(200);
        expect(adminPatchRes.body.summary).toBe('Admin override');

        void adminUserId;
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario F — Progress note CRUD (mentor)
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario F: Progress note CRUD (mentor)', () => {
    it(
      'mentor creates note → 201; lists notes for child → contains it; ' +
        'PATCH body → 200; PATCH empty body → 400; DELETE → 204; ' +
        'PATCH non-existent → 404',
      async () => {
        const { kgId, adminToken } = await createKgWithAdmin(
          'note-f',
          '+77010100051',
        );
        const childId = await createChild(adminToken);

        const mentorUserId = await seedUser('+77010100052');
        await seedStaffMember(kgId, mentorUserId, 'mentor');
        const mentorToken = await mintToken({
          sub: mentorUserId,
          role: 'mentor',
          kindergartenId: kgId,
        });

        // POST — create note
        const createRes = await request(server)
          .post('/api/v1/staff/progress-notes')
          .set('Authorization', `Bearer ${mentorToken}`)
          .send({
            child_id: childId,
            body: 'Child made great progress today.',
          })
          .expect(201);

        const noteId = createRes.body.id as string;
        expect(noteId).toBeDefined();
        expect(createRes.body.body).toBe('Child made great progress today.');

        // GET list filtered by child_id
        const listRes = await request(server)
          .get(`/api/v1/staff/progress-notes?child_id=${childId}`)
          .set('Authorization', `Bearer ${mentorToken}`)
          .expect(200);
        expect(
          (listRes.body.items as Array<{ id: string }>).some(
            (n) => n.id === noteId,
          ),
        ).toBe(true);

        // PATCH body
        const patchRes = await request(server)
          .patch(`/api/v1/staff/progress-notes/${noteId}`)
          .set('Authorization', `Bearer ${mentorToken}`)
          .send({ body: 'Updated progress note.' })
          .expect(200);
        expect(patchRes.body.body).toBe('Updated progress note.');

        // PATCH empty body → 422 (class-validator @IsNotEmpty on UpdateProgressNoteDto)
        // or 400 (entity invariant). Actual: validation fires at DTO level → 422.
        const emptyBodyRes = await request(server)
          .patch(`/api/v1/staff/progress-notes/${noteId}`)
          .set('Authorization', `Bearer ${mentorToken}`)
          .send({ body: '' })
          .expect(422);
        expect(emptyBodyRes.body).toBeDefined();

        // DELETE → 204
        await request(server)
          .delete(`/api/v1/staff/progress-notes/${noteId}`)
          .set('Authorization', `Bearer ${mentorToken}`)
          .expect(204);

        // PATCH non-existent → 404
        const fakeId = randomUUID();
        await request(server)
          .patch(`/api/v1/staff/progress-notes/${fakeId}`)
          .set('Authorization', `Bearer ${mentorToken}`)
          .send({ body: 'Should fail' })
          .expect(404);
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario G — Author-only progress note PATCH/DELETE
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario G: Author-only progress note PATCH/DELETE', () => {
    it(
      'mentor A creates note; ' +
        'mentor B PATCH → 403 progress_note_not_authored_by_you; ' +
        'mentor B DELETE → 403; ' +
        'admin DELETE → 204 (admin override in service.delete); ' +
        'admin PATCH → 200 (admin bypass pre-fetches mentor_id)',
      async () => {
        const { kgId, adminToken } = await createKgWithAdmin(
          'note-g',
          '+77010100061',
        );
        const childId = await createChild(adminToken);

        // Mentor A
        const mentorAUserId = await seedUser('+77010100062');
        await seedStaffMember(kgId, mentorAUserId, 'mentor');
        const mentorAToken = await mintToken({
          sub: mentorAUserId,
          role: 'mentor',
          kindergartenId: kgId,
        });

        // Mentor B
        const mentorBUserId = await seedUser('+77010100063');
        await seedStaffMember(kgId, mentorBUserId, 'mentor');
        const mentorBToken = await mintToken({
          sub: mentorBUserId,
          role: 'mentor',
          kindergartenId: kgId,
        });

        // Mentor A creates note
        const createRes = await request(server)
          .post('/api/v1/staff/progress-notes')
          .set('Authorization', `Bearer ${mentorAToken}`)
          .send({ child_id: childId, body: 'Mentor A note' })
          .expect(201);
        const noteId = createRes.body.id as string;

        // Mentor B PATCH → 403
        const rejectPatchRes = await request(server)
          .patch(`/api/v1/staff/progress-notes/${noteId}`)
          .set('Authorization', `Bearer ${mentorBToken}`)
          .send({ body: 'Hijack' })
          .expect(403);
        expect(
          rejectPatchRes.body.message ?? rejectPatchRes.body.error,
        ).toMatch(/progress_note_not_authored_by_you/);

        // Mentor B DELETE → 403
        const rejectDeleteRes = await request(server)
          .delete(`/api/v1/staff/progress-notes/${noteId}`)
          .set('Authorization', `Bearer ${mentorBToken}`)
          .expect(403);
        expect(
          rejectDeleteRes.body.message ?? rejectDeleteRes.body.error,
        ).toMatch(/progress_note_not_authored_by_you/);

        // Admin PATCH → 200 (controller pre-fetches note.mentorId and passes
        // it as callerMentorId, bypassing the author check — same pattern as
        // diagnostic entry admin bypass from T4)
        const adminPatchRes = await request(server)
          .patch(`/api/v1/staff/progress-notes/${noteId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ body: 'Admin override body' })
          .expect(200);
        expect(adminPatchRes.body.body).toBe('Admin override body');

        // Admin DELETE → 204 (service.delete has isAdmin bypass)
        await request(server)
          .delete(`/api/v1/staff/progress-notes/${noteId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(204);
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario H — My-todos 6-month staleness algorithm
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario H: My-todos 6-month staleness algorithm', () => {
    it(
      'child-1 never assessed → in todos (days_since_last=null); ' +
        'child-2 assessed <6 months ago → NOT in todos; ' +
        'child-3 assessed >6 months ago → in todos; ' +
        'nulls first in sort order',
      async () => {
        const { kgId, adminToken } = await createKgWithAdmin(
          'todos-h',
          '+77010100071',
        );

        // Create specialist with psychologist type
        const specUserId = await seedUser('+77010100072');
        const specStaffId = await seedStaffMember(
          kgId,
          specUserId,
          'specialist',
          'psychologist',
        );
        const specToken = await mintToken({
          sub: specUserId,
          role: 'specialist',
          kindergartenId: kgId,
        });

        // Template for psychologist
        const template = await createTemplate(adminToken, {
          specialist_type: 'psychologist',
        });

        // child-1: never assessed
        const child1Id = await createChild(adminToken, {
          full_name: 'Child Never',
        });

        // child-2: assessed recently (<6 months ago, e.g. 30 days)
        const child2Id = await createChild(adminToken, {
          full_name: 'Child Recent',
        });
        await request(server)
          .post('/api/v1/staff/diagnostic-entries')
          .set('Authorization', `Bearer ${specToken}`)
          .send({
            child_id: child2Id,
            template_id: template.id,
            assessment_date: isoPast(30),
            data: validEntryData(),
          })
          .expect(201);

        // child-3: assessed >6 months ago (200 days)
        const child3Id = await createChild(adminToken, {
          full_name: 'Child Stale',
        });
        await request(server)
          .post('/api/v1/staff/diagnostic-entries')
          .set('Authorization', `Bearer ${specToken}`)
          .send({
            child_id: child3Id,
            template_id: template.id,
            assessment_date: isoPast(200),
            data: validEntryData(),
          })
          .expect(201);

        // Specialist GET /staff/my-todos
        const todosRes = await request(server)
          .get('/api/v1/staff/my-todos')
          .set('Authorization', `Bearer ${specToken}`)
          .expect(200);

        const todos = todosRes.body.children_needing_diagnostic as Array<{
          child_id: string;
          last_assessment_date: string | null;
          days_since_last: number | null;
        }>;

        const ids = todos.map((t) => t.child_id);
        expect(ids).toContain(child1Id);
        expect(ids).toContain(child3Id);
        expect(ids).not.toContain(child2Id);

        // Nulls first — child1 (never assessed) should appear before child3
        const child1Idx = ids.indexOf(child1Id);
        const child3Idx = ids.indexOf(child3Id);
        expect(child1Idx).toBeLessThan(child3Idx);

        // days_since_last is null for never-assessed child
        const child1Todo = todos.find((t) => t.child_id === child1Id);
        expect(child1Todo?.last_assessment_date).toBeNull();
        expect(child1Todo?.days_since_last).toBeNull();

        // days_since_last > 180 for stale child
        const child3Todo = todos.find((t) => t.child_id === child3Id);
        expect(child3Todo?.days_since_last).toBeGreaterThan(180);

        // Admin GET /staff/my-todos?specialist_type=psychologist → same result
        const adminTodosRes = await request(server)
          .get('/api/v1/staff/my-todos?specialist_type=psychologist')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        const adminIds = (
          adminTodosRes.body.children_needing_diagnostic as Array<{
            child_id: string;
          }>
        ).map((t) => t.child_id);
        expect(adminIds).toContain(child1Id);
        expect(adminIds).toContain(child3Id);
        expect(adminIds).not.toContain(child2Id);

        // Admin without specialist_type and no ?specialist_type query → 403
        // The admin staff_member created by SaaS has no specialist_type.
        const adminNoTypeRes = await request(server)
          .get('/api/v1/staff/my-todos')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(403);
        expect(
          adminNoTypeRes.body.message ?? adminNoTypeRes.body.error,
        ).toMatch(/staff_member_must_have_specialist_type/);

        void specStaffId;
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario I — Parent reads diagnostics
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario I: Parent reads diagnostics', () => {
    it('primary guardian (view_diagnostics=true by default) reads diagnostic entries and progress notes', async () => {
      const { kgId, adminToken } = await createKgWithAdmin(
        'parent-i',
        '+77010100081',
      );
      const template = await createTemplate(adminToken, {
        specialist_type: 'psychologist',
      });
      const childId = await createChild(adminToken);

      // Seed specialist, create entry
      const specUserId = await seedUser('+77010100082');
      await seedStaffMember(kgId, specUserId, 'specialist', 'psychologist');
      const specToken = await mintToken({
        sub: specUserId,
        role: 'specialist',
        kindergartenId: kgId,
      });
      const entryRes = await request(server)
        .post('/api/v1/staff/diagnostic-entries')
        .set('Authorization', `Bearer ${specToken}`)
        .send({
          child_id: childId,
          template_id: template.id,
          assessment_date: isoToday(),
          data: validEntryData(),
        })
        .expect(201);
      const entryId = entryRes.body.id as string;

      // Seed mentor, create progress note
      const mentorUserId = await seedUser('+77010100083');
      await seedStaffMember(kgId, mentorUserId, 'mentor');
      const mentorToken = await mintToken({
        sub: mentorUserId,
        role: 'mentor',
        kindergartenId: kgId,
      });
      const noteRes = await request(server)
        .post('/api/v1/staff/progress-notes')
        .set('Authorization', `Bearer ${mentorToken}`)
        .send({ child_id: childId, body: 'Parent-facing note' })
        .expect(201);
      const noteId = noteRes.body.id as string;

      // Seed primary guardian
      const parentUserId = await seedUser('+77010100084');
      await seedApprovedGuardian(kgId, childId, parentUserId, 'primary');
      const parentToken = await mintToken({
        sub: parentUserId,
        role: 'parent',
        kindergartenId: kgId,
      });

      // Parent GET diagnostics list
      const diagListRes = await request(server)
        .get(`/api/v1/parent/children/${childId}/diagnostics`)
        .set('Authorization', `Bearer ${parentToken}`)
        .expect(200);
      expect(
        (diagListRes.body.items as Array<{ id: string }>).some(
          (e) => e.id === entryId,
        ),
      ).toBe(true);

      // Parent GET diagnostics/:entryId
      const diagDetailRes = await request(server)
        .get(`/api/v1/parent/children/${childId}/diagnostics/${entryId}`)
        .set('Authorization', `Bearer ${parentToken}`)
        .expect(200);
      expect(diagDetailRes.body.id).toBe(entryId);

      // Parent GET progress-notes
      const notesListRes = await request(server)
        .get(`/api/v1/parent/children/${childId}/progress-notes`)
        .set('Authorization', `Bearer ${parentToken}`)
        .expect(200);
      expect(
        (notesListRes.body.items as Array<{ id: string }>).some(
          (n) => n.id === noteId,
        ),
      ).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario J — Nanny 403 on diagnostics
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario J: Nanny 403 on diagnostics', () => {
    it(
      'nanny guardian (view_diagnostics=false by default) receives 403 ' +
        'on all diagnostic & progress-note endpoints',
      async () => {
        const { kgId, adminToken } = await createKgWithAdmin(
          'nanny-j',
          '+77010100091',
        );
        const template = await createTemplate(adminToken, {
          specialist_type: 'psychologist',
        });
        const childId = await createChild(adminToken);

        // Seed specialist, create entry so there's content to potentially leak
        const specUserId = await seedUser('+77010100092');
        await seedStaffMember(kgId, specUserId, 'specialist', 'psychologist');
        const specToken = await mintToken({
          sub: specUserId,
          role: 'specialist',
          kindergartenId: kgId,
        });
        const entryRes = await request(server)
          .post('/api/v1/staff/diagnostic-entries')
          .set('Authorization', `Bearer ${specToken}`)
          .send({
            child_id: childId,
            template_id: template.id,
            assessment_date: isoToday(),
            data: validEntryData(),
          })
          .expect(201);
        const entryId = entryRes.body.id as string;

        // Seed nanny guardian (view_diagnostics=false by role default)
        const nannyUserId = await seedUser('+77010100093');
        await seedApprovedGuardian(kgId, childId, nannyUserId, 'nanny');
        const nannyToken = await mintToken({
          sub: nannyUserId,
          role: 'parent',
          kindergartenId: kgId,
        });

        // Nanny GET diagnostics list → 403
        const diagListRes = await request(server)
          .get(`/api/v1/parent/children/${childId}/diagnostics`)
          .set('Authorization', `Bearer ${nannyToken}`)
          .expect(403);
        expect(diagListRes.body.message ?? diagListRes.body.error).toMatch(
          /nanny_no_diagnostics_access/,
        );

        // Nanny GET diagnostics/:entryId → 403
        const diagDetailRes = await request(server)
          .get(`/api/v1/parent/children/${childId}/diagnostics/${entryId}`)
          .set('Authorization', `Bearer ${nannyToken}`)
          .expect(403);
        expect(diagDetailRes.body.message ?? diagDetailRes.body.error).toMatch(
          /nanny_no_diagnostics_access/,
        );

        // Nanny GET progress-notes → 403
        const notesRes = await request(server)
          .get(`/api/v1/parent/children/${childId}/progress-notes`)
          .set('Authorization', `Bearer ${nannyToken}`)
          .expect(403);
        expect(notesRes.body.message ?? notesRes.body.error).toMatch(
          /nanny_no_diagnostics_access/,
        );
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario K — Cross-tenant phantom (RLS isolation)
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario K: Cross-tenant phantom (RLS isolation)', () => {
    it(
      'admin/specialist in kg-A cannot see kg-A resources from kg-B context; ' +
        'POST with template_id from kg-A → 404 from kg-B specialist',
      async () => {
        const kgA = await createKgWithAdmin('rls-ka', '+77010100101');
        const kgB = await createKgWithAdmin('rls-kb', '+77010100102');

        // kg-A admin creates a template
        const templateA = await createTemplate(kgA.adminToken, {
          specialist_type: 'psychologist',
        });

        // kg-A specialist creates an entry
        const specAUserId = await seedUser('+77010100103');
        await seedStaffMember(
          kgA.kgId,
          specAUserId,
          'specialist',
          'psychologist',
        );
        const specAToken = await mintToken({
          sub: specAUserId,
          role: 'specialist',
          kindergartenId: kgA.kgId,
        });
        const childA = await createChild(kgA.adminToken);

        await request(server)
          .post('/api/v1/staff/diagnostic-entries')
          .set('Authorization', `Bearer ${specAToken}`)
          .send({
            child_id: childA,
            template_id: templateA.id,
            assessment_date: isoToday(),
            data: validEntryData(),
          })
          .expect(201);

        // kg-B admin GET list of templates → should NOT see kg-A template
        const bTemplateListRes = await request(server)
          .get('/api/v1/admin/diagnostic-templates')
          .set('Authorization', `Bearer ${kgB.adminToken}`)
          .expect(200);
        expect(
          (bTemplateListRes.body.items as Array<{ id: string }>).some(
            (t) => t.id === templateA.id,
          ),
        ).toBe(false);

        // kg-B admin GET /admin/diagnostic-templates/:idFromKgA → 404
        await request(server)
          .get(`/api/v1/admin/diagnostic-templates/${templateA.id}`)
          .set('Authorization', `Bearer ${kgB.adminToken}`)
          .expect(404);

        // kg-B specialist POST with template_id from kg-A → 404
        const specBUserId = await seedUser('+77010100104');
        await seedStaffMember(
          kgB.kgId,
          specBUserId,
          'specialist',
          'psychologist',
        );
        const specBToken = await mintToken({
          sub: specBUserId,
          role: 'specialist',
          kindergartenId: kgB.kgId,
        });
        const childB = await createChild(kgB.adminToken);

        const xTenantRes = await request(server)
          .post('/api/v1/staff/diagnostic-entries')
          .set('Authorization', `Bearer ${specBToken}`)
          .send({
            child_id: childB,
            template_id: templateA.id, // kg-A template, cross-tenant
            assessment_date: isoToday(),
            data: validEntryData(),
          })
          .expect(404);
        expect(xTenantRes.body.message ?? xTenantRes.body.error).toMatch(
          /diagnostic_template_not_found/,
        );
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario L — Cross-tenant child reference on POST /staff/diagnostic-entries
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario L: Cross-tenant child_id on POST diagnostic-entries → 404', () => {
    it(
      'kg-A specialist POSTs an entry with child_id from kg-B → 404 not_found ' +
        '(service-side ChildNotFoundError ownership guard; T7-HIGH#1). ' +
        'ChildNotFoundError extends NotFoundError with the generic `not_found` ' +
        'code; the message body carries `child not found: <id>`.',
      async () => {
        const kgA = await createKgWithAdmin('xtnt-l-a', '+77010100201');
        const kgB = await createKgWithAdmin('xtnt-l-b', '+77010100202');

        // kg-A: template + specialist
        const templateA = await createTemplate(kgA.adminToken, {
          specialist_type: 'psychologist',
        });
        const specAUserId = await seedUser('+77010100203');
        await seedStaffMember(
          kgA.kgId,
          specAUserId,
          'specialist',
          'psychologist',
        );
        const specAToken = await mintToken({
          sub: specAUserId,
          role: 'specialist',
          kindergartenId: kgA.kgId,
        });

        // kg-B: a child the kg-A specialist must NOT be allowed to reference
        const childB = await createChild(kgB.adminToken);

        const res = await request(server)
          .post('/api/v1/staff/diagnostic-entries')
          .set('Authorization', `Bearer ${specAToken}`)
          .send({
            child_id: childB,
            template_id: templateA.id,
            assessment_date: isoToday(),
            data: validEntryData(),
          })
          .expect(404);

        expect(res.body.error).toBe('not_found');
        // Service must reject before touching the templates table — the response
        // must not surface a template-related error code.
        expect(res.body.error).not.toBe('diagnostic_template_not_found');
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario M — Cross-tenant child reference on POST /staff/progress-notes
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario M: Cross-tenant child_id on POST progress-notes → 404', () => {
    it(
      'kg-A mentor POSTs a note with child_id from kg-B → 404 not_found ' +
        '(service-side ChildNotFoundError ownership guard; T7-HIGH#2)',
      async () => {
        const kgA = await createKgWithAdmin('xtnt-m-a', '+77010100211');
        const kgB = await createKgWithAdmin('xtnt-m-b', '+77010100212');

        // kg-A: mentor
        const mentorAUserId = await seedUser('+77010100213');
        await seedStaffMember(kgA.kgId, mentorAUserId, 'mentor');
        const mentorAToken = await mintToken({
          sub: mentorAUserId,
          role: 'mentor',
          kindergartenId: kgA.kgId,
        });

        // kg-B: a child the kg-A mentor must NOT be allowed to reference
        const childB = await createChild(kgB.adminToken);

        const res = await request(server)
          .post('/api/v1/staff/progress-notes')
          .set('Authorization', `Bearer ${mentorAToken}`)
          .send({
            child_id: childB,
            body: 'Cross-tenant attempt',
          })
          .expect(404);

        expect(res.body.error).toBe('not_found');
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario N — Mentor 403 on staff-diagnostic-templates (T6-M5 regression)
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario N: Mentor 403 on /staff/diagnostic-templates', () => {
    it('mentor GET /staff/diagnostic-templates → 403 (admin + specialist only)', async () => {
      const { kgId, adminToken } = await createKgWithAdmin(
        'tpl-n',
        '+77010100221',
      );
      // Create a template so the listing has something to gate on.
      await createTemplate(adminToken, { specialist_type: 'psychologist' });

      const mentorUserId = await seedUser('+77010100222');
      await seedStaffMember(kgId, mentorUserId, 'mentor');
      const mentorToken = await mintToken({
        sub: mentorUserId,
        role: 'mentor',
        kindergartenId: kgId,
      });

      await request(server)
        .get('/api/v1/staff/diagnostic-templates')
        .set('Authorization', `Bearer ${mentorToken}`)
        .expect(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario O — Optimistic-lock race on template PATCH (B22a T4 — closes
  // SM3 + B18 T6-M4)
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario O: Optimistic-lock 409 on stale template PATCH', () => {
    it(
      'launching N concurrent PATCHes against the same template — at least ' +
        'one losing writer returns 409 optimistic_lock_conflict',
      async () => {
        const { adminToken } = await createKgWithAdmin('tpl-o', '+77010100231');
        const created = await createTemplate(adminToken);

        // Launch N concurrent admin PATCHes against the same template.
        // The HTTP layer doesn't expose `row_version` on the wire, so
        // we can't pin a stale snapshot from the client side. Instead
        // we rely on connection-pool parallelism: with N=8 requests
        // hitting the same row, two or more findById SELECTs will
        // overlap with the first UPDATE's commit window, causing at
        // least one conditional UPDATE to find 0 matching rows →
        // service throws `OptimisticLockError` → DomainErrorFilter
        // maps to 409 `optimistic_lock_conflict`.
        //
        // The test is correctness-asserting (NOT timing-asserting):
        //   - at least 1 request must return 200 (someone wins),
        //   - at least 1 request must return 409 (someone loses),
        //   - every 409 response carries `error === 'optimistic_lock_conflict'`,
        //   - no other status code is acceptable.
        const N = 8;
        const responses = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            request(server)
              .patch(`/api/v1/admin/diagnostic-templates/${created.id}`)
              .set('Authorization', `Bearer ${adminToken}`)
              .send({ name: `Writer ${i}` }),
          ),
        );

        const statuses = responses.map((r) => r.status);
        const wins = statuses.filter((s) => s === 200).length;
        const conflicts = statuses.filter((s) => s === 409).length;
        const others = statuses.filter((s) => s !== 200 && s !== 409);

        expect(others).toEqual([]); // no surprise 5xx / 4xx
        expect(wins).toBeGreaterThanOrEqual(1);
        expect(conflicts).toBeGreaterThanOrEqual(1);
        expect(wins + conflicts).toBe(N);

        for (const r of responses) {
          if (r.status === 409) {
            expect(r.body.error).toBe('optimistic_lock_conflict');
          }
        }
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario P — H12 schema PATCH version-pinning (B22a T7)
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario P: schema PATCH on template with entries → 409', () => {
    it(
      'admin creates template + 1 entry; ' +
        'PATCH name only → 200; ' +
        'PATCH schema → 409 template_has_entries; ' +
        'underlying schema/version unchanged in DB',
      async () => {
        const { kgId, adminToken } = await createKgWithAdmin(
          'tpl-p',
          '+77010100241',
        );
        const template = await createTemplate(adminToken, {
          specialist_type: 'psychologist',
        });
        const childId = await createChild(adminToken);

        // Seed a specialist + author one entry against the template.
        const specUserId = await seedUser('+77010100242');
        await seedStaffMember(kgId, specUserId, 'specialist', 'psychologist');
        const specToken = await mintToken({
          sub: specUserId,
          role: 'specialist',
          kindergartenId: kgId,
        });
        await request(server)
          .post('/api/v1/staff/diagnostic-entries')
          .set('Authorization', `Bearer ${specToken}`)
          .send({
            child_id: childId,
            template_id: template.id,
            assessment_date: isoToday(),
            data: validEntryData(),
          })
          .expect(201);

        // Sanity: PATCH name still allowed even with entries pinned.
        await request(server)
          .patch(`/api/v1/admin/diagnostic-templates/${template.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ name: 'Renamed (with entries)' })
          .expect(200);

        // PATCH schema (structurally different) → 409 template_has_entries.
        const newSchema = validSchema({
          sections: [
            {
              title: 'General v2',
              fields: [
                {
                  key: 'mood',
                  label: 'Mood',
                  type: 'scale',
                  required: true,
                  min: 1,
                  max: 10,
                },
              ],
            },
          ],
        });
        const conflictRes = await request(server)
          .patch(`/api/v1/admin/diagnostic-templates/${template.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ schema: newSchema })
          .expect(409);
        expect(conflictRes.body.error).toBe('template_has_entries');

        // Verify DB state: schema + version unchanged (guard fired BEFORE write).
        const reloaded = await request(server)
          .get(`/api/v1/admin/diagnostic-templates/${template.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(reloaded.body.version).toBe(1);
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Scenario Q — admin override on PATCH writes audit columns (B22a T7)
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Scenario Q: admin override stamps last_modified_by_user_id', () => {
    it(
      'specialist authors entry; admin PATCHes summary; ' +
        'DB last_modified_by_user_id = admin.userId; last_modified_at populated',
      async () => {
        const {
          kgId,
          userId: adminUserId,
          adminToken,
        } = await createKgWithAdmin('aud-q-ent', '+77010100251');
        const template = await createTemplate(adminToken, {
          specialist_type: 'psychologist',
        });
        const childId = await createChild(adminToken);

        const specUserId = await seedUser('+77010100252');
        await seedStaffMember(kgId, specUserId, 'specialist', 'psychologist');
        const specToken = await mintToken({
          sub: specUserId,
          role: 'specialist',
          kindergartenId: kgId,
        });

        // Specialist creates the entry.
        const createRes = await request(server)
          .post('/api/v1/staff/diagnostic-entries')
          .set('Authorization', `Bearer ${specToken}`)
          .send({
            child_id: childId,
            template_id: template.id,
            assessment_date: isoToday(),
            data: validEntryData(),
          })
          .expect(201);
        const entryId = createRes.body.id as string;

        // Pre-state: never modified → both audit columns NULL.
        const preRows = (await ctx.dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          return m.query(
            `SELECT last_modified_by_user_id, last_modified_at
               FROM diagnostic_entries WHERE id = $1`,
            [entryId],
          );
        })) as Array<{
          last_modified_by_user_id: string | null;
          last_modified_at: Date | null;
        }>;
        expect(preRows[0].last_modified_by_user_id).toBeNull();
        expect(preRows[0].last_modified_at).toBeNull();

        // Admin PATCH override.
        await request(server)
          .patch(`/api/v1/staff/diagnostic-entries/${entryId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ summary: 'Admin override for audit' })
          .expect(200);

        // Post-state: audit stamps populated with admin's users.id.
        const postRows = (await ctx.dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          return m.query(
            `SELECT last_modified_by_user_id, last_modified_at, summary
               FROM diagnostic_entries WHERE id = $1`,
            [entryId],
          );
        })) as Array<{
          last_modified_by_user_id: string | null;
          last_modified_at: Date | null;
          summary: string | null;
        }>;
        expect(postRows[0].last_modified_by_user_id).toBe(adminUserId);
        expect(postRows[0].last_modified_at).not.toBeNull();
        expect(postRows[0].summary).toBe('Admin override for audit');
      },
    );

    it(
      'mentor authors note; admin PATCHes body; ' +
        'progress_notes.last_modified_by_user_id = admin.userId',
      async () => {
        const {
          kgId,
          userId: adminUserId,
          adminToken,
        } = await createKgWithAdmin('aud-q-note', '+77010100261');
        const childId = await createChild(adminToken);

        const mentorUserId = await seedUser('+77010100262');
        await seedStaffMember(kgId, mentorUserId, 'mentor');
        const mentorToken = await mintToken({
          sub: mentorUserId,
          role: 'mentor',
          kindergartenId: kgId,
        });

        const createRes = await request(server)
          .post('/api/v1/staff/progress-notes')
          .set('Authorization', `Bearer ${mentorToken}`)
          .send({ child_id: childId, body: 'Initial body.' })
          .expect(201);
        const noteId = createRes.body.id as string;

        // Admin overrides the body.
        await request(server)
          .patch(`/api/v1/staff/progress-notes/${noteId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ body: 'Admin-overridden body.' })
          .expect(200);

        const rows = (await ctx.dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          return m.query(
            `SELECT last_modified_by_user_id, last_modified_at, body
               FROM progress_notes WHERE id = $1`,
            [noteId],
          );
        })) as Array<{
          last_modified_by_user_id: string | null;
          last_modified_at: Date | null;
          body: string;
        }>;
        expect(rows[0].last_modified_by_user_id).toBe(adminUserId);
        expect(rows[0].last_modified_at).not.toBeNull();
        expect(rows[0].body).toBe('Admin-overridden body.');
      },
    );
  });
});
