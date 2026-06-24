/**
 * B6 parent onboarding e2e — exercises the parent-side surface for
 * cross-tenant link / unlink + the auto-approve hook on OTP verify.
 *
 * Endpoints under test:
 *   - POST /api/v1/auth/otp/request   (re-issued for each parent)
 *   - POST /api/v1/auth/otp/verify    (auto-approve hook fires here)
 *   - POST /api/v1/auth/refresh       (re-scopes a parent's JWT after approval)
 *   - POST /api/v1/parent/children/link
 *   - POST /api/v1/parent/children/:id/unlink
 *   - GET  /api/v1/parent/children
 *   - GET  /api/v1/parent/approvals/pending
 *   - POST /api/v1/parent/approvals/:guardianId/approve
 *   - GET  /api/v1/children/:id        (cross-tenant isolation regression)
 *
 * HTTP status mapping (per IMPLEMENTATION_PLAN §4 / B6 plan §3.4):
 *   - ChildNotFoundForIinError       → 404 (extends NotFoundError)
 *   - MultipleChildrenForIinError    → 409 (extends ConflictError)
 *   - AlreadyLinkedToChildError      → 409 (extends ConflictError)
 *   - AlreadyPendingForChildError    → 409 (extends ConflictError)
 *   - PrimaryCannotSelfUnlinkError   → 403 (extends ForbiddenActionError)
 *
 * The DomainErrorFilter shape is `{ statusCode, error, message }` — the `error`
 * field carries the stable string code that the frontend matches on.
 */
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-parent-onboarding@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

interface AuthBody {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_in: number;
  pending_role_select: boolean;
  roles: {
    role: string;
    kindergarten_id: string | null;
    group_id: string | null;
    specialist_type: string | null;
  }[];
  user: {
    id: string;
    phone: string;
    full_name: string;
  };
}

describe('B6 parent onboarding (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;

  // ── helpers ─────────────────────────────────────────────────────────────

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
   * Creates a kindergarten via the super-admin path. The admin staff member
   * is auto-provisioned with `phone`. Returns the kg id, the admin user id,
   * and an access token issued via the standard OTP flow (NOT a direct mint)
   * so the kindergarten_id is correctly embedded by assembleRoles.
   */
  async function createKgWithAdmin(
    slug: string,
    phone: string,
  ): Promise<{ kgId: string; adminUserId: string; adminToken: string }> {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'Onboarding-Test KG',
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;

    // Admin has exactly one staff role (admin in this kg) — OTP verify will
    // assemble that single role and issue a kg-scoped access token.
    const auth = await otpLogin(phone, 'admin');
    return {
      kgId: body.kindergarten.id,
      adminUserId: body.user.id,
      adminToken: auth.access_token,
    };
  }

  function extractCode(): string {
    const last = ctx.sms.lastSent;
    if (!last) throw new Error('no SMS captured');
    const m = /(\d{6})/.exec(last.message);
    if (!m) throw new Error('no 6-digit code in message');
    return m[1];
  }

  /**
   * Run the full OTP request+verify dance for a phone. Returns the parsed
   * AuthBody — caller picks the access/refresh token. Each call clears
   * `ctx.sms.lastSent` first so concurrent OTPs do not bleed across parents.
   */
  async function otpLogin(
    phone: string,
    app: 'parent' | 'staff' | 'admin' = 'parent',
  ): Promise<AuthBody> {
    ctx.sms.lastSent = null;
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone, app })
      .expect(202);
    const code = extractCode();
    const res = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone, code, app })
      .expect(200);
    return res.body as AuthBody;
  }

  /**
   * Create a child by hand via the admin path. Returns the child id.
   */
  async function createChild(
    adminToken: string,
    payload: { full_name: string; date_of_birth: string; iin?: string },
  ): Promise<string> {
    const res = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload)
      .expect(201);
    return res.body.id as string;
  }

  /**
   * Run the B5 enrollment flow up to `card_created` — creates a child + a
   * pending_approval primary guardian whose user is resolved from
   * `contactPhone`. Returns the created child id so the test can later
   * mint OTPs against the contact phone and exercise the auto-approve hook.
   *
   * Mirrors `test/enrollment.e2e-spec.ts` "creates a child + pending primary
   * guardian on transition →card_created".
   */
  async function runEnrollmentCardCreated(
    adminToken: string,
    args: {
      contactName: string;
      contactPhone: string;
      childName: string;
      childDob: string;
    },
  ): Promise<{ childId: string }> {
    const grp = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Aralar', capacity: 20 })
      .expect(201);

    const create = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        contactName: args.contactName,
        contactPhone: args.contactPhone,
        childName: args.childName,
        childDob: args.childDob,
      })
      .expect(201);

    await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toStatus: 'in_processing' })
      .expect(200);

    const card = await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toStatus: 'card_created', currentGroupId: grp.body.id })
      .expect(200);

    return { childId: card.body.enrollment.childId as string };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.server;
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

  // ── A. Auto-approve primary on OTP verify ───────────────────────────────

  it('returns kg-scoped JWT + auto-approved primary on parent OTP verify (Scenario A)', async () => {
    const a = await createKgWithAdmin('po-a', '+77011120001');
    const parentXPhone = '+77011110001';
    const enrollment = await runEnrollmentCardCreated(a.adminToken, {
      contactName: 'Aigul Serikova',
      contactPhone: parentXPhone,
      childName: 'Aliya Serikova',
      childDob: '2021-08-15',
    });

    // Parent X passes OTP — auto-approve flips the pending-primary row to
    // `approved`, and assembleRoles picks up the kg via the guardian path,
    // so the access token comes back with kindergarten_id embedded.
    const auth = await otpLogin(parentXPhone);
    expect(auth.pending_role_select).toBe(false);
    expect(auth.roles).toEqual([
      {
        role: 'parent',
        kindergarten_id: a.kgId,
        group_id: null,
        specialist_type: null,
      },
    ]);
    expect(auth.user.phone).toBe(parentXPhone);

    // GET /parent/children returns the enrollment-child since the row is
    // now approved.
    const list = await request(server)
      .get('/api/v1/parent/children')
      .set('Authorization', `Bearer ${auth.access_token}`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(enrollment.childId);

    // Direct DB-side verification: status flipped, approved_by = parent X.
    const rows = (await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT status, role, approved_by, user_id FROM child_guardians
           WHERE child_id = $1`,
        [enrollment.childId],
      );
    })) as Array<{
      status: string;
      role: string;
      approved_by: string;
      user_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('approved');
    expect(rows[0].role).toBe('primary');
    expect(rows[0].approved_by).toBe(rows[0].user_id);
  });

  // ── B. Link as nanny → primary approves → list resolves ─────────────────

  it('returns approved nanny and visible child after primary approval (Scenario B)', async () => {
    const a = await createKgWithAdmin('po-b', '+77011120002');
    const parentXPhone = '+77011110001';
    const parentYPhone = '+77011110002';

    const enrollment = await runEnrollmentCardCreated(a.adminToken, {
      contactName: 'X-name',
      contactPhone: parentXPhone,
      childName: 'B-Child',
      childDob: '2021-08-15',
    });
    // Set IIN on the enrollment-created child via admin PATCH so Y can link
    // by IIN. (POST /children is a separate path; we want the enrollment
    // child here to keep the primary auto-approve scope identical.)
    const iin = '001122334455';
    await request(server)
      .patch(`/api/v1/children/${enrollment.childId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ iin })
      .expect(200);

    // Parent X logs in → triggers auto-approve of the primary row.
    const xAuth = await otpLogin(parentXPhone);

    // Parent Y logs in (no guardian rows yet — JWT is unscoped parent).
    const yInitial = await otpLogin(parentYPhone);
    expect(yInitial.roles).toEqual([
      {
        role: 'parent',
        kindergarten_id: null,
        group_id: null,
        specialist_type: null,
      },
    ]);

    // Y links by IIN as nanny — pending_approval row created. Response is a
    // minimal ack: only guardian {id, status, role, can_pickup} + pending=true.
    // No child personal data until primary approves.
    const link = await request(server)
      .post('/api/v1/parent/children/link')
      .set('Authorization', `Bearer ${yInitial.access_token}`)
      .send({ iin, role: 'nanny' })
      .expect(201);
    expect(link.body.guardian.status).toBe('pending_approval');
    expect(link.body.guardian.role).toBe('nanny');
    expect(link.body.pending).toBe(true);
    expect(link.body.child).toBeUndefined();
    expect(link.body.guardian.user_id).toBeUndefined();
    expect(link.body.guardian.kindergarten_id).toBeUndefined();
    const yGuardianId = link.body.guardian.id as string;

    // Primary X sees the pending row.
    const pending = await request(server)
      .get('/api/v1/parent/approvals/pending')
      .set('Authorization', `Bearer ${xAuth.access_token}`)
      .expect(200);
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0].id).toBe(yGuardianId);

    // Primary X approves Y.
    const approved = await request(server)
      .post(`/api/v1/parent/approvals/${yGuardianId}/approve`)
      .set('Authorization', `Bearer ${xAuth.access_token}`)
      .send({ grant_approval_rights: false })
      .expect(200);
    expect(approved.body.status).toBe('approved');

    // Y refreshes token — now assembleRoles sees the approved guardian and
    // issues a kg-scoped access token for kg_A.
    const refreshed = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: yInitial.refresh_token })
      .expect(200);
    const yScoped = refreshed.body as AuthBody;
    expect(yScoped.roles).toEqual([
      {
        role: 'parent',
        kindergarten_id: a.kgId,
        group_id: null,
        specialist_type: null,
      },
    ]);

    // Y now sees the child.
    const yList = await request(server)
      .get('/api/v1/parent/children')
      .set('Authorization', `Bearer ${yScoped.access_token}`)
      .expect(200);
    expect(yList.body).toHaveLength(1);
    expect(yList.body[0].id).toBe(enrollment.childId);
  });

  // ── C. Link not found ───────────────────────────────────────────────────

  it('rejects link by unknown IIN with code child_not_found_for_iin (Scenario C)', async () => {
    await createKgWithAdmin('po-c', '+77011120003');
    const parentZPhone = '+77011110003';
    const zAuth = await otpLogin(parentZPhone);

    const res = await request(server)
      .post('/api/v1/parent/children/link')
      .set('Authorization', `Bearer ${zAuth.access_token}`)
      .send({ iin: '999999999999', role: 'secondary' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('child_not_found_for_iin');
  });

  // ── D. Already pending (Y re-tries the same link) ───────────────────────

  it('rejects re-link on a pending row with code already_pending_for_child (Scenario D)', async () => {
    const a = await createKgWithAdmin('po-d', '+77011120004');
    const parentYPhone = '+77011110002';
    const iin = '001122334456';

    // Manually-created child that Y will try to link to.
    await createChild(a.adminToken, {
      full_name: 'Direct-Linked-Child',
      date_of_birth: '2021-08-15',
      iin,
    });

    const yAuth = await otpLogin(parentYPhone);
    // First link → 201 pending.
    await request(server)
      .post('/api/v1/parent/children/link')
      .set('Authorization', `Bearer ${yAuth.access_token}`)
      .send({ iin, role: 'secondary' })
      .expect(201);

    // Second link with the same body → 409 already_pending_for_child.
    const dup = await request(server)
      .post('/api/v1/parent/children/link')
      .set('Authorization', `Bearer ${yAuth.access_token}`)
      .send({ iin, role: 'secondary' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('already_pending_for_child');
  });

  // ── D2. Applicant's pending-requests view ───────────────────────────────
  // Regression for a route-shadowing bug: `GET /parent/children/pending-requests`
  // must NOT be captured by the `GET /parent/children/:id` param route (whose
  // ChildAccessGuard would treat "pending-requests" as a child uuid → 500).
  it('lists the applicant own pending link requests with a masked child name (Scenario D2)', async () => {
    const a = await createKgWithAdmin('po-d2', '+77011120044');
    const parentPhone = '+77011110022';
    const iin = '001122339001';

    await createChild(a.adminToken, {
      full_name: 'Aigerim Maskedkyzy',
      date_of_birth: '2021-08-15',
      iin,
    });

    const auth = await otpLogin(parentPhone);
    await request(server)
      .post('/api/v1/parent/children/link')
      .set('Authorization', `Bearer ${auth.access_token}`)
      .send({ iin, role: 'secondary' })
      .expect(201);

    const res = await request(server)
      .get('/api/v1/parent/children/pending-requests')
      .set('Authorization', `Bearer ${auth.access_token}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('pending_approval');
    expect(res.body[0].role).toBe('secondary');
    // Child PII stays hidden: name is masked to first-letter + ****.
    expect(res.body[0].child_name_masked).toBe('A**** M****');
    expect(res.body[0]).not.toHaveProperty('iin');
    expect(res.body[0].kindergarten?.name).toBeTruthy();
  });

  // ── E. Multi-kg parent ──────────────────────────────────────────────────

  it('rejects link when the IIN matches children in multiple kgs with code multiple_children_for_iin (Scenario E)', async () => {
    const a = await createKgWithAdmin('po-e-a', '+77011120005');
    const b = await createKgWithAdmin('po-e-b', '+77011120006');
    const iin = '002233445566';

    await createChild(a.adminToken, {
      full_name: 'Multi-A',
      date_of_birth: '2021-09-15',
      iin,
    });
    await createChild(b.adminToken, {
      full_name: 'Multi-B',
      date_of_birth: '2021-09-15',
      iin,
    });

    const parentWPhone = '+77011110004';
    const wAuth = await otpLogin(parentWPhone);
    const res = await request(server)
      .post('/api/v1/parent/children/link')
      .set('Authorization', `Bearer ${wAuth.access_token}`)
      .send({ iin, role: 'secondary' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('multiple_children_for_iin');
    // Information-disclosure guard: response must NOT leak the candidate
    // kindergarten ids — that would let any authenticated caller probe
    // IIN ↔ tenant membership across the platform via a single 409.
    expect(res.body.details).toEqual({ iin });
    expect(res.body.details?.kindergartenIds).toBeUndefined();
  });

  // ── F. Self-unlink (non-primary) ─────────────────────────────────────────

  it('returns 204 on self-unlink and admits a fresh link afterwards (Scenario F)', async () => {
    const a = await createKgWithAdmin('po-f', '+77011120007');
    const parentXPhone = '+77011110001';
    const parentYPhone = '+77011110002';
    const iin = '003344556677';

    // Enrollment-driven child + pending primary X.
    const enrollment = await runEnrollmentCardCreated(a.adminToken, {
      contactName: 'X-name',
      contactPhone: parentXPhone,
      childName: 'F-Child',
      childDob: '2021-08-15',
    });
    await request(server)
      .patch(`/api/v1/children/${enrollment.childId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ iin })
      .expect(200);

    // Parent X logs in → primary auto-approves.
    const xAuth = await otpLogin(parentXPhone);

    // Y logs in, links as nanny, X approves.
    const yInitial = await otpLogin(parentYPhone);
    const link = await request(server)
      .post('/api/v1/parent/children/link')
      .set('Authorization', `Bearer ${yInitial.access_token}`)
      .send({ iin, role: 'nanny' })
      .expect(201);
    const yGuardianId = link.body.guardian.id as string;
    await request(server)
      .post(`/api/v1/parent/approvals/${yGuardianId}/approve`)
      .set('Authorization', `Bearer ${xAuth.access_token}`)
      .send({ grant_approval_rights: false })
      .expect(200);

    // Y refreshes for a kg-scoped JWT.
    const yScopedRes = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: yInitial.refresh_token })
      .expect(200);
    const yScoped = yScopedRes.body as AuthBody;

    // Y self-unlinks → 204.
    await request(server)
      .post(`/api/v1/parent/children/${enrollment.childId}/unlink`)
      .set('Authorization', `Bearer ${yScoped.access_token}`)
      .expect(204);

    // Y refreshes again — no approved kg row left, JWT goes back to unscoped
    // parent. (Refresh is required because the previous access token still
    // carries the stale scope.)
    const yPostRefreshRes = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: yScoped.refresh_token })
      .expect(200);
    const yPostRefresh = yPostRefreshRes.body as AuthBody;
    expect(yPostRefresh.roles).toEqual([
      {
        role: 'parent',
        kindergarten_id: null,
        group_id: null,
        specialist_type: null,
      },
    ]);

    // Re-link: revoked row does NOT block — partial-unique idx allows a fresh
    // pending row alongside the revoked one.
    const reLink = await request(server)
      .post('/api/v1/parent/children/link')
      .set('Authorization', `Bearer ${yPostRefresh.access_token}`)
      .send({ iin, role: 'secondary' });
    expect(reLink.status).toBe(201);
    expect(reLink.body.guardian.status).toBe('pending_approval');
  });

  // ── G. Primary cannot self-unlink ───────────────────────────────────────

  it('rejects primary self-unlink with code primary_cannot_self_unlink (Scenario G)', async () => {
    const a = await createKgWithAdmin('po-g', '+77011120008');
    const parentXPhone = '+77011110001';

    const enrollment = await runEnrollmentCardCreated(a.adminToken, {
      contactName: 'X-name',
      contactPhone: parentXPhone,
      childName: 'G-Child',
      childDob: '2021-08-15',
    });

    // OTP verify auto-approves the primary row → kg-scoped JWT.
    const xAuth = await otpLogin(parentXPhone);
    expect(xAuth.roles[0].kindergarten_id).toBe(a.kgId);

    const res = await request(server)
      .post(`/api/v1/parent/children/${enrollment.childId}/unlink`)
      .set('Authorization', `Bearer ${xAuth.access_token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('primary_cannot_self_unlink');
  });

  // ── H. Cross-tenant isolation regression ────────────────────────────────

  it('hides KG-A child from KG-B admin via RLS (Scenario H)', async () => {
    const a = await createKgWithAdmin('po-h-a', '+77011120009');
    const b = await createKgWithAdmin('po-h-b', '+77011120010');

    const childAId = await createChild(a.adminToken, {
      full_name: 'A-only',
      date_of_birth: '2021-09-15',
    });

    // KG-B admin reads KG-A's child by id → 404 (RLS hides the row).
    const res = await request(server)
      .get(`/api/v1/children/${childAId}`)
      .set('Authorization', `Bearer ${b.adminToken}`);
    expect(res.status).toBe(404);
  });
});
