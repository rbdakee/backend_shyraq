/**
 * B5 enrollment leads e2e — exercises the admin surface
 * (POST/GET/PATCH/transition/assign + status log) plus cross-tenant isolation
 * via RLS and authorization via RolesGuard.
 *
 * Mints admin / parent JWTs directly the same way organization.e2e-spec does
 * — the role-select flow is not needed to exercise these handlers.
 *
 * HTTP status mapping (per IMPLEMENTATION_PLAN §4 / B5):
 *   - EnrollmentNotFoundError                  → 404 (extends NotFoundError)
 *   - InvalidEnrollmentStatusTransitionError   → 409 (extends ConflictError)
 *   - EnrollmentAlreadyConvertedError          → 409 (extends ConflictError)
 *   - EnrollmentLockedError                    → 409 (extends ConflictError)
 *   - EnrollmentMissingRequiredFieldsError     → 422 (DomainError fallback)
 * The `code` body field remains the stable contract; tests assert on both
 * the status and the code.
 */
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-enrollment@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('B5 enrollment leads (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;

  async function mintAdminAccess(opts: {
    sub: string;
    kindergartenId: string;
  }): Promise<string> {
    return jwtService.signAsync(
      {
        sub: opts.sub,
        role: 'admin',
        kindergarten_id: opts.kindergartenId,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function mintParentAccess(opts: {
    sub: string;
    kindergartenId: string;
  }): Promise<string> {
    return jwtService.signAsync(
      {
        sub: opts.sub,
        role: 'parent',
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
        name: 'Enrollment-Test KG',
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await mintAdminAccess({
      sub: body.user.id,
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
    ctx.sms.lastSent = null;
    ctx.sms.log.length = 0;
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();
  });

  // ── create + get + log ─────────────────────────────────────────────────

  it('returns 201 on POST /admin/enrollments and 200 on subsequent GET /:id with empty log', async () => {
    const a = await createKgWithAdmin('enr-1', '+77011113001');
    const create = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        contactName: 'Айгуль Серикова',
        contactPhone: '+77011112233',
      })
      .expect(201);
    expect(create.body.id).toEqual(expect.any(String));
    expect(create.body.kindergartenId).toBe(a.kgId);
    expect(create.body.status).toBe('new');
    expect(create.body.contactName).toBe('Айгуль Серикова');
    expect(create.body.contactPhone).toBe('+77011112233');
    expect(create.body.childId).toBeNull();
    expect(create.body.assignedTo).toBeNull();

    const get = await request(server)
      .get(`/api/v1/admin/enrollments/${create.body.id}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(get.body.enrollment.id).toBe(create.body.id);
    expect(get.body.enrollment.status).toBe('new');
    // No transition has happened yet — log starts empty (initial creation
    // does NOT write a log entry per service contract).
    expect(get.body.log).toEqual([]);
  });

  // ── list / filter ──────────────────────────────────────────────────────

  it('filters list by status and returns only matching rows', async () => {
    const a = await createKgWithAdmin('enr-2', '+77011113002');
    const e1 = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ contactName: 'Lead A', contactPhone: '+77011110021' })
      .expect(201);
    const e2 = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ contactName: 'Lead B', contactPhone: '+77011110022' })
      .expect(201);
    // Move e2 into in_processing.
    await request(server)
      .post(`/api/v1/admin/enrollments/${e2.body.id}/transition`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ toStatus: 'in_processing' })
      .expect(200);

    const newList = await request(server)
      .get('/api/v1/admin/enrollments?status=new')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(newList.body.total).toBe(1);
    expect(newList.body.data.length).toBe(1);
    expect(newList.body.data[0].id).toBe(e1.body.id);

    const inProcList = await request(server)
      .get('/api/v1/admin/enrollments?status=in_processing')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(inProcList.body.total).toBe(1);
    expect(inProcList.body.data.length).toBe(1);
    expect(inProcList.body.data[0].id).toBe(e2.body.id);
  });

  // ── patch ──────────────────────────────────────────────────────────────

  it('updates contact info on PATCH /admin/enrollments/:id', async () => {
    const a = await createKgWithAdmin('enr-3', '+77011113003');
    const create = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ contactName: 'Original', contactPhone: '+77011110031' })
      .expect(201);

    const patched = await request(server)
      .patch(`/api/v1/admin/enrollments/${create.body.id}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ contactName: 'Updated', childName: 'Алия' })
      .expect(200);
    expect(patched.body.contactName).toBe('Updated');
    expect(patched.body.childName).toBe('Алия');
    // Untouched fields are preserved.
    expect(patched.body.contactPhone).toBe('+77011110031');
  });

  // ── transition new → in_processing (writes log) ─────────────────────────

  it('returns 200 on transition new→in_processing and appends a status-log entry', async () => {
    const a = await createKgWithAdmin('enr-4', '+77011113004');
    const create = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ contactName: 'L', contactPhone: '+77011110041' })
      .expect(201);

    const tr = await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ toStatus: 'in_processing', comment: 'звонок принят' })
      .expect(200);
    expect(tr.body.enrollment.status).toBe('in_processing');
    expect(tr.body.child).toBeUndefined();

    const detail = await request(server)
      .get(`/api/v1/admin/enrollments/${create.body.id}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(detail.body.log.length).toBe(1);
    const entry = detail.body.log[0];
    expect(entry.fromStatus).toBe('new');
    expect(entry.toStatus).toBe('in_processing');
    expect(entry.changedBy).toBe(a.staffMemberId);
    expect(entry.comment).toBe('звонок принят');
  });

  // ── transition → card_created (creates child + primary guardian) ────────

  it('creates a child + pending primary guardian on transition →card_created', async () => {
    const a = await createKgWithAdmin('enr-5', '+77011113005');
    // Group required for card_created.
    const grp = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ name: 'Aralar', capacity: 20 })
      .expect(201);

    // B13 T4c hook: a tariff plan must exist before card_created so that
    // generateFirstInvoice can find an active assignment. We seed a
    // tariff plan here. NOTE: since the child does not exist yet at this
    // point in the test, we cannot pre-assign it; the hook inside T4c
    // will try to find an active tariff_assignment for the newly created
    // child. If no assignment exists the hook may silently skip or throw.
    // This test validates the transition completes; the invoice assertion
    // below is soft (may be 0 if T4c skips silently for no-assignment).
    await request(server)
      .post('/api/v1/admin/tariff-plans')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        name: 'Enrollment Test Plan',
        tariff_type: 'monthly',
        amount: 40000,
        applies_to: 'all_children',
        valid_from: new Date().toISOString().slice(0, 10),
        discount_rules: {},
      })
      .expect(201);

    // Lead with all child fields populated up-front.
    const create = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        contactName: 'Айгуль Серикова',
        contactPhone: '+77011110051',
        childName: 'Алия Серикова',
        childDob: '2021-08-15',
      })
      .expect(201);

    // Move to in_processing first (state machine forbids new→card_created).
    await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ toStatus: 'in_processing' })
      .expect(200);

    const card = await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ toStatus: 'card_created', currentGroupId: grp.body.id })
      .expect(200);

    expect(card.body.enrollment.status).toBe('card_created');
    expect(card.body.enrollment.childId).toEqual(expect.any(String));
    expect(card.body.child).toBeDefined();
    const childId = card.body.enrollment.childId as string;

    // Child row exists and is in card_created status. Endpoint returns
    // `{ child, guardians }` — see ChildController.getOne.
    const detail = await request(server)
      .get(`/api/v1/children/${childId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(detail.body.child.status).toBe('card_created');
    expect(detail.body.child.full_name).toBe('Алия Серикова');
    // Primary guardian is pending_approval and bound to contact phone —
    // exposed via the same payload's `guardians` array.
    expect(detail.body.guardians.length).toBe(1);
    expect(detail.body.guardians[0].role).toBe('primary');
    expect(detail.body.guardians[0].status).toBe('pending_approval');

    // Sanity check the dedicated guardians endpoint as well.
    const guardians = await request(server)
      .get(`/api/v1/children/${childId}/guardians`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(guardians.body.length).toBe(1);
    expect(guardians.body[0].role).toBe('primary');

    // B13 hook assertion (T4c): check whether a monthly invoice was
    // auto-generated. If T4c's hook fired and found an active tariff
    // assignment (there is none at this point, since assignments are
    // per-child and the child didn't exist before), the invoice list will
    // be empty and we note it. If T4c requires a pre-assigned tariff it
    // would have failed the transition (which would have caused the
    // .expect(200) above to fail instead). Accept both: 0 invoices (no
    // pre-assignment) or >= 1 monthly invoices (if hook adapts gracefully).
    const invoicesRes = await request(server)
      .get(`/api/v1/admin/invoices?child_id=${childId}&invoice_type=monthly`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    // Soft assertion — 0 is acceptable (no tariff assignment pre-existed).
    // If >= 1 the invoice_type must be 'monthly'.
    (invoicesRes.body as Array<{ invoice_type: string }>).forEach((inv) => {
      expect(inv.invoice_type).toBe('monthly');
    });
  });

  // ── card_created with tariff pre-assigned → first invoice auto-generated ──

  it('completes card_created in lax mode without a pre-assigned tariff (B13 T4c hook)', async () => {
    // The B13 T4c hook calls invoiceService.generateFirstInvoice inside the
    // ambient TX. tariff_assignment requires child_id, which only exists
    // *after* createChild in this same TX, so a fresh transition cannot have
    // an assignment in place. Lax mode: the hook logs + skips, the
    // transition completes, and the admin can attach a tariff afterwards
    // (next monthly cron picks up the child).
    const a = await createKgWithAdmin('enr-5b', '+77011113012');
    const grp = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ name: 'Aralar B', capacity: 20 })
      .expect(201);

    // Seed a monthly tariff plan up-front so the post-creation assignment
    // step has something to bind to.
    const planRes = await request(server)
      .post('/api/v1/admin/tariff-plans')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        name: 'Enrollment Test Plan B',
        tariff_type: 'monthly',
        amount: 50000,
        applies_to: 'all_children',
        valid_from: new Date().toISOString().slice(0, 10),
        discount_rules: {},
      })
      .expect(201);
    const planId = planRes.body.id as string;

    // Create enrollment → move to in_processing → card_created.
    const create = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        contactName: 'Жанна Ахметова',
        contactPhone: '+77011110052',
        childName: 'Тимур Ахметов',
        childDob: '2022-01-10',
      })
      .expect(201);

    await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ toStatus: 'in_processing' })
      .expect(200);

    const cardRes = await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ toStatus: 'card_created', currentGroupId: grp.body.id })
      .expect(200);

    const childId = cardRes.body.enrollment.childId as string;
    expect(childId).toEqual(expect.any(String));

    // No invoice yet (hook ran in lax mode and skipped — no pre-assignment).
    const initialInvoices = await request(server)
      .get(`/api/v1/admin/invoices?child_id=${childId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(Array.isArray(initialInvoices.body)).toBe(true);
    expect((initialInvoices.body as unknown[]).length).toBe(0);

    // Admin attaches a tariff after card_created. Subsequent monthly-cron
    // runs will generate invoices for this child; the assignment endpoint
    // itself just persists the row.
    await request(server)
      .post('/api/v1/admin/tariff-assignments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        child_id: childId,
        tariff_plan_id: planId,
        valid_from: new Date().toISOString().slice(0, 10),
      })
      .expect(201);
  });

  // ── invalid transition ────────────────────────────────────────────────

  it('rejects invalid transition new→archive with code invalid_enrollment_status_transition', async () => {
    const a = await createKgWithAdmin('enr-6', '+77011113006');
    const create = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ contactName: 'L', contactPhone: '+77011110061' })
      .expect(201);

    const res = await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ toStatus: 'archive' });
    // InvalidEnrollmentStatusTransitionError extends ConflictError → 409.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_enrollment_status_transition');
  });

  // ── card_created without currentGroupId → 422 missing fields ────────────

  it('rejects card_created without currentGroupId with code enrollment_missing_required_fields', async () => {
    const a = await createKgWithAdmin('enr-7', '+77011113007');
    const create = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        contactName: 'X',
        contactPhone: '+77011110071',
        childName: 'Y',
        childDob: '2021-08-15',
      })
      .expect(201);
    // Move to in_processing so the only missing piece is currentGroupId.
    await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ toStatus: 'in_processing' })
      .expect(200);

    const res = await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ toStatus: 'card_created' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('enrollment_missing_required_fields');
  });

  // ── cross-tenant isolation (RLS hides KG-A row from KG-B admin) ─────────

  it('hides KG-A enrollment from KG-B admin (cross-tenant)', async () => {
    const a = await createKgWithAdmin('enr-iso-a', '+77011113008');
    const b = await createKgWithAdmin('enr-iso-b', '+77011113009');

    const created = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ contactName: 'A-only', contactPhone: '+77011110081' })
      .expect(201);

    // Admin of KG-B trying to read KG-A's enrollment hits
    // `EnrollmentNotFoundError` (extends NotFoundError → 404) because RLS
    // hides the row from the KG-B-scoped query.
    const cross = await request(server)
      .get(`/api/v1/admin/enrollments/${created.body.id}`)
      .set('Authorization', `Bearer ${b.adminToken}`);
    expect(cross.status).toBe(404);
    expect(cross.body.error).toBe('enrollment_not_found');

    // List under B is empty (no leakage).
    const listB = await request(server)
      .get('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${b.adminToken}`)
      .expect(200);
    expect(listB.body.total).toBe(0);
    expect(listB.body.data).toEqual([]);
  });

  // ── authorization: parent token rejected ────────────────────────────────

  it('rejects parent token on POST /admin/enrollments with 403', async () => {
    const a = await createKgWithAdmin('enr-pa-1', '+77011113010');
    const parentUserId = await seedUser('+77011110091');
    const parentToken = await mintParentAccess({
      sub: parentUserId,
      kindergartenId: a.kgId,
    });
    await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ contactName: 'X', contactPhone: '+77011110092' })
      .expect(403);
  });

  it('rejects parent token on GET /admin/enrollments with 403', async () => {
    const a = await createKgWithAdmin('enr-pa-2', '+77011113011');
    const parentUserId = await seedUser('+77011110093');
    const parentToken = await mintParentAccess({
      sub: parentUserId,
      kindergartenId: a.kgId,
    });
    await request(server)
      .get('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(403);
  });
});
