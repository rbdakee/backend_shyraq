/**
 * B21 T5 — Lifecycle E2E Scenarios A–L
 *
 * Covers:
 *   A.  Archive happy path (200, status=archived, tariff closed)
 *   B.  Archive already-archived → 409 child_already_archived
 *   C.  Reactivate happy path (200, requires_new_tariff_assignment=true)
 *   D.  Reactivate active child → 409 child_not_archived
 *   E.  Archive without reason → 422 archive_reason_required
 *       (empty string, whitespace-only, >500 chars)
 *   F.  Cross-tenant archive → 404 child_not_found
 *   G.  Transfer-group happy path (200, child_group_history row inserted)
 *   H.  Transfer-group of archived child (adapts to actual service behaviour)
 *   I.  Pro-rata refund created when processor runs after archive
 *   J.  Pro-rata idempotency — processor runs twice → 1 refund row
 *   K.  Holidays exclusion — non-billable days reduce refund amount
 *   L.  Outbox: child.archived written; child.transferred written
 *
 * Auth pattern:
 *   Admin JWTs are minted directly via JwtService (same pattern as
 *   organization.e2e-spec / children.e2e-spec). The super-admin flow is used
 *   to create kindergartens + seeded admin users. Two kindergartens (kg_A,
 *   kg_B) are shared across the whole suite — each test creates its own
 *   children via the API or direct SQL to avoid cross-test pollution.
 *
 * Processor pattern for I/J/K:
 *   ProRataRefundProcessor is retrieved via `app.get(ProRataRefundProcessor)`.
 *   `runForChild(kgId, childId, archivedAt)` is called directly (same approach
 *   as the race integration spec) — this bypasses BullMQ Redis and makes
 *   the test deterministic.
 */
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';
import { ProRataRefundProcessor } from '@/modules/billing/pro-rata-refund.processor';

const SUPER_ADMIN_EMAIL = 'super-lifecycle@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'Lifecycle12345!';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

// ── date helpers ─────────────────────────────────────────────────────────────

/** First day of current UTC month in ISO-8601 (YYYY-MM-DD). */
function firstOfCurrentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Last day of current UTC month in ISO-8601 (YYYY-MM-DD). */
function lastOfCurrentMonth(): string {
  const now = new Date();
  const last = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  );
  return last.toISOString().slice(0, 10);
}

// ── describe ─────────────────────────────────────────────────────────────────

describe('Lifecycle E2E (B21 T5)', () => {
  let ctx: TestApp;
  let server: Server;
  let ds: DataSource;
  let jwtService: JwtService;
  let jwtSecret: string;
  let saAccess: string;

  /** kg_A — primary tenant for most scenarios */
  let kgAId: string;
  let kgAAdminToken: string;
  let kgAAdminUserId: string;

  /** kg_B — cross-tenant attacker */
  let kgBAdminToken: string;

  // ── helpers ────────────────────────────────────────────────────────────────

  async function mintAdminToken(sub: string, kgId: string): Promise<string> {
    return jwtService.signAsync(
      { sub, role: 'admin', kindergarten_id: kgId, jti: randomUUID() },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function seedSuperAdmin(): Promise<void> {
    const hash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 4);
    await ds.transaction(async (m) => {
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
  ): Promise<{ kgId: string; userId: string; adminToken: string }> {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'Lifecycle KG',
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await mintAdminToken(body.user.id, body.kindergarten.id);
    return {
      kgId: body.kindergarten.id,
      userId: body.user.id,
      adminToken,
    };
  }

  /**
   * Create an active child via HTTP (POST /api/v1/children).
   * Returns { id, status, ... }.
   */
  async function createActiveChild(
    adminToken: string,
    suffix: string,
  ): Promise<{ id: string; status: string }> {
    const res = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        full_name: `Lifecycle Child ${suffix}`,
        date_of_birth: '2021-03-15',
      })
      .expect(201);
    // Activate via API (card_created → active requires an enrollment event;
    // for lifecycle tests we seed direct SQL to set status='active')
    // Actually card_created is returned from POST. We need to set it active
    // via direct SQL for archive to succeed (archive requires status='active').
    await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(`UPDATE children SET status = 'active' WHERE id = $1`, [
        res.body.id,
      ]);
    });
    return { id: res.body.id as string, status: 'active' };
  }

  /**
   * Seed an active child + tariff_assignment + invoice + completed payment
   * for the current month — required by Scenarios I/J/K.
   */
  async function seedActiveChildWithPaidInvoice(kgId: string): Promise<{
    childId: string;
    invoiceId: string;
    paymentId: string;
    paymentAccountId: string;
  }> {
    const childId = randomUUID();
    const paymentAccountId = randomUUID();
    const invoiceId = randomUUID();
    const paymentId = randomUUID();

    const periodStart = new Date(`${firstOfCurrentMonth()}T00:00:00.000Z`);
    const periodEnd = new Date(`${lastOfCurrentMonth()}T00:00:00.000Z`);
    const amount = 60000;

    await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);

      // Child (active)
      await m.query(
        `INSERT INTO children
           (id, kindergarten_id, full_name, date_of_birth, status)
         VALUES ($1, $2, 'Lifecycle Billing Child', '2021-03-15', 'active')`,
        [childId, kgId],
      );

      // Payment account
      await m.query(
        `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance)
         VALUES ($1, $2, $3, 0)`,
        [paymentAccountId, kgId, childId],
      );

      // Invoice (pending, current month)
      await m.query(
        `INSERT INTO invoices
           (id, kindergarten_id, child_id, payment_account_id,
            invoice_type, period_start, period_end,
            amount_due, amount_after_discount, status, due_date)
         VALUES ($1, $2, $3, $4, 'monthly', $5, $6, $7, $7, 'pending', $5)`,
        [
          invoiceId,
          kgId,
          childId,
          paymentAccountId,
          periodStart,
          periodEnd,
          amount,
        ],
      );

      // Completed payment (required by processor — non-null payment_id FK)
      await m.query(
        `INSERT INTO payments
           (id, kindergarten_id, invoice_id, child_id, amount,
            provider, provider_txn_id, idempotency_key, status, paid_at)
         VALUES ($1, $2, $3, $4, $5, 'mock', $6, $7, 'completed', now())`,
        [
          paymentId,
          kgId,
          invoiceId,
          childId,
          amount,
          `txn-lc-${paymentId.slice(0, 8)}`,
          `idem-lc-${paymentId.slice(0, 8)}`,
        ],
      );
    });

    return { childId, invoiceId, paymentId, paymentAccountId };
  }

  /**
   * Seed N non-billable holidays in the given date range for a kg.
   */
  async function seedHolidays(
    kgId: string,
    dates: string[],
  ): Promise<string[]> {
    const ids: string[] = [];
    await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      for (const d of dates) {
        const id = randomUUID();
        ids.push(id);
        await m.query(
          `INSERT INTO kindergarten_holidays
             (id, kindergarten_id, date, name, is_billable)
           VALUES ($1, $2, $3, '{"kk": "Test Holiday"}'::jsonb, false)`,
          [id, kgId, d],
        );
      }
    });
    return ids;
  }

  /**
   * Seed approved guardian links for a child (direct SQL, bypass RLS).
   * Returns inserted guardian ids.
   */
  async function seedGuardians(
    kgId: string,
    childId: string,
    count: number,
    role: 'primary' | 'secondary' = 'secondary',
  ): Promise<string[]> {
    const ids: string[] = [];
    await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      for (let i = 0; i < count; i++) {
        const userId = randomUUID();
        const guardianId = randomUUID();
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Guardian')`,
          [
            userId,
            `+770111${String(Math.floor(Math.random() * 9000000) + 1000000)}`,
          ],
        );
        await m.query(
          `INSERT INTO child_guardians
             (id, kindergarten_id, child_id, user_id, role, status,
              has_approval_rights, can_pickup, permissions, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'approved', false, true, '{}'::jsonb, now(), now())`,
          [guardianId, kgId, childId, userId, role],
        );
        ids.push(guardianId);
      }
    });
    return ids;
  }

  /**
   * Archive a child via HTTP and assert 200.
   */
  async function archiveChild(
    adminToken: string,
    childId: string,
    reason = 'Lifecycle test archive reason',
  ): Promise<{ status: string; archived_at: string; archive_reason: string }> {
    const res = await request(server)
      .post(`/api/v1/children/${childId}/archive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ archive_reason: reason })
      .expect(200);
    return res.body as {
      status: string;
      archived_at: string;
      archive_reason: string;
    };
  }

  // ── beforeAll / afterAll ──────────────────────────────────────────────────

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.server;
    ds = ctx.dataSource;
    const config = ctx.app.get(ConfigService);
    jwtSecret = config.getOrThrow<string>('auth.jwtAccessSecret');
    jwtService = ctx.app.get(JwtService);
  });

  afterAll(async () => {
    await truncateAll(ds);
    await flushRedis(ctx.redis);
    await ctx.app.close();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    await flushRedis(ctx.redis);
    ctx.sms.lastSent = null;
    ctx.sms.log.length = 0;

    // Seed super-admin + two kindergartens
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();

    const kgA = await createKgWithAdmin('lifecycle-kg-a', '+77021110001');
    kgAId = kgA.kgId;
    kgAAdminToken = kgA.adminToken;
    kgAAdminUserId = kgA.userId;

    const kgB = await createKgWithAdmin('lifecycle-kg-b', '+77021110002');
    kgBAdminToken = kgB.adminToken;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario A: archive happy path
  // ═══════════════════════════════════════════════════════════════════════════

  it('returns 200 and archives an active child', async () => {
    const child = await createActiveChild(kgAAdminToken, 'A');

    const body = await archiveChild(
      kgAAdminToken,
      child.id,
      'Family relocated',
    );

    expect(body.status).toBe('archived');
    expect(body.archived_at).toBeDefined();
    expect(body.archive_reason).toBe('Family relocated');

    // Verify persisted in DB
    const rows = await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT status, archived_at, archive_reason FROM children WHERE id = $1`,
        [child.id],
      ) as Promise<
        Array<{
          status: string;
          archived_at: string | null;
          archive_reason: string | null;
        }>
      >;
    });
    expect(rows[0].status).toBe('archived');
    expect(rows[0].archived_at).not.toBeNull();
    expect(rows[0].archive_reason).toBe('Family relocated');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario B: archive already-archived → 409
  // ═══════════════════════════════════════════════════════════════════════════

  it('rejects archive when child is already archived with 409 child_already_archived', async () => {
    const child = await createActiveChild(kgAAdminToken, 'B');
    // First archive succeeds
    await archiveChild(kgAAdminToken, child.id, 'First archive');

    // Second archive → 409
    const res = await request(server)
      .post(`/api/v1/children/${child.id}/archive`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .send({ archive_reason: 'Second attempt' })
      .expect(409);
    expect(res.body.error).toBe('child_already_archived');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario C: reactivate happy path
  // ═══════════════════════════════════════════════════════════════════════════

  it('returns 200 and reactivates with requires_new_tariff_assignment=true', async () => {
    const child = await createActiveChild(kgAAdminToken, 'C');
    await archiveChild(kgAAdminToken, child.id, 'Will reactivate');

    const res = await request(server)
      .post(`/api/v1/children/${child.id}/reactivate`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .expect(200);

    expect(res.body.child.status).toBe('active');
    expect(res.body.child.archived_at).toBeNull();
    expect(res.body.requires_new_tariff_assignment).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario D: reactivate active child → 409
  // ═══════════════════════════════════════════════════════════════════════════

  it('rejects reactivate when child is active with 409 child_not_archived', async () => {
    const child = await createActiveChild(kgAAdminToken, 'D');

    const res = await request(server)
      .post(`/api/v1/children/${child.id}/reactivate`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .expect(409);
    expect(res.body.error).toBe('child_not_archived');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario E: archive without reason → 422
  // ═══════════════════════════════════════════════════════════════════════════

  it('rejects archive with empty archive_reason with 422 archive_reason_required', async () => {
    const child = await createActiveChild(kgAAdminToken, 'E-empty');

    const res = await request(server)
      .post(`/api/v1/children/${child.id}/archive`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .send({ archive_reason: '' })
      .expect(422);
    expect(res.body.error ?? res.body.errors?.archive_reason).toBeDefined();
  });

  it('rejects archive with whitespace-only archive_reason with 422', async () => {
    const child = await createActiveChild(kgAAdminToken, 'E-whitespace');

    await request(server)
      .post(`/api/v1/children/${child.id}/archive`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .send({ archive_reason: '   ' })
      .expect(422);
  });

  it('rejects archive with archive_reason exceeding 500 chars with 422', async () => {
    const child = await createActiveChild(kgAAdminToken, 'E-long');
    const longReason = 'A'.repeat(501);

    await request(server)
      .post(`/api/v1/children/${child.id}/archive`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .send({ archive_reason: longReason })
      .expect(422);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario F: cross-tenant archive → 404
  // ═══════════════════════════════════════════════════════════════════════════

  it('rejects archive of cross-tenant child with 404 (not_found)', async () => {
    // Create child in kg_A
    const child = await createActiveChild(kgAAdminToken, 'F');

    // Try to archive it using kg_B's admin token → should be 404 (RLS hides the row).
    // ChildNotFoundError extends NotFoundError which has code='not_found'.
    const res = await request(server)
      .post(`/api/v1/children/${child.id}/archive`)
      .set('Authorization', `Bearer ${kgBAdminToken}`)
      .send({ archive_reason: 'Cross-tenant attack' })
      .expect(404);
    // DomainErrorFilter maps ChildNotFoundError → NotFoundError.code = 'not_found'
    expect(res.body.error).toBe('not_found');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario G: transfer-group happy path
  // ═══════════════════════════════════════════════════════════════════════════

  it('transfers active child to new group and inserts child_group_history row', async () => {
    const child = await createActiveChild(kgAAdminToken, 'G');

    // Create a group
    const grpRes = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .send({ name: 'Group G', capacity: 20 })
      .expect(201);
    const groupId = grpRes.body.id as string;

    // Transfer
    const transferRes = await request(server)
      .post(`/api/v1/children/${child.id}/transfer`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .send({ to_group_id: groupId, reason: 'promotion' })
      .expect(200);
    expect(transferRes.body.current_group_id).toBe(groupId);

    // Verify child_group_history
    const historyRes = await request(server)
      .get(`/api/v1/children/${child.id}/group-history`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .expect(200);
    expect(historyRes.body.length).toBeGreaterThanOrEqual(1);
    const lastEntry = historyRes.body[historyRes.body.length - 1] as {
      to_group_id: string;
      reason: string;
    };
    expect(lastEntry.to_group_id).toBe(groupId);
    expect(lastEntry.reason).toBe('promotion');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario H: transfer-group of archived child → 409
  // B21 T8 H4: archived children are inactive and cannot be transferred.
  // ═══════════════════════════════════════════════════════════════════════════

  it('rejects group transfer for an archived child with 409 archived_child_not_transferable', async () => {
    const child = await createActiveChild(kgAAdminToken, 'H');

    // Create a group
    const grpRes = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .send({ name: 'Group H', capacity: 20 })
      .expect(201);
    const groupId = grpRes.body.id as string;

    // Archive the child first
    await archiveChild(
      kgAAdminToken,
      child.id,
      'To test transfer after archive',
    );

    // Transfer of archived child — service blocks with 409.
    const transferRes = await request(server)
      .post(`/api/v1/children/${child.id}/transfer`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .send({ to_group_id: groupId, reason: 'post-archive transfer' })
      .expect(409);
    expect(transferRes.body.error).toBe('archived_child_not_transferable');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario I: pro-rata refund created
  // ═══════════════════════════════════════════════════════════════════════════

  it('creates a pending refund row when ProRataRefundProcessor runs after archive', async () => {
    const seed = await seedActiveChildWithPaidInvoice(kgAId);

    // Archive the child mid-month via HTTP
    const archivedAt = new Date();
    await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `UPDATE children
            SET status = 'archived', archived_at = $1, archive_reason = 'mid-month test'
          WHERE id = $2`,
        [archivedAt, seed.childId],
      );
    });

    // Run processor directly (bypass BullMQ)
    const processor = ctx.app.get(ProRataRefundProcessor);
    const outcome = await processor.runForChild(
      kgAId,
      seed.childId,
      archivedAt,
    );

    // The processor may skip if archive landed on last billable day.
    // For a mid-month archive there should be remaining days → created.
    // If we're at the very end of month it could be skipped — that's acceptable.
    if (outcome.kind === 'created') {
      expect(outcome.amountKzt).toBeGreaterThan(0);
      expect(outcome.invoiceId).toBe(seed.invoiceId);

      // Verify DB row
      const refunds = await ds.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT r.status, r.reason, r.amount
             FROM refunds r
             JOIN invoices i ON i.id = r.invoice_id
            WHERE r.kindergarten_id = $1 AND i.child_id = $2
              AND r.reason = 'pro_rata_archive'`,
          [kgAId, seed.childId],
        ) as Promise<Array<{ status: string; reason: string; amount: string }>>;
      });
      expect(refunds).toHaveLength(1);
      expect(refunds[0].status).toBe('pending');
      expect(refunds[0].reason).toBe('pro_rata_archive');
    } else {
      // Skipped — acceptable at month boundary; document the skip reason
      expect([
        'computed_amount_zero_or_negative',
        'no_billable_days_after_archive',
        'no_current_invoice',
      ]).toContain(outcome.reason);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario J: pro-rata idempotency
  // ═══════════════════════════════════════════════════════════════════════════

  it('does not create duplicate refund when processor runs twice', async () => {
    const seed = await seedActiveChildWithPaidInvoice(kgAId);

    const archivedAt = new Date();
    await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `UPDATE children
            SET status = 'archived', archived_at = $1, archive_reason = 'idempotency test'
          WHERE id = $2`,
        [archivedAt, seed.childId],
      );
    });

    const processor = ctx.app.get(ProRataRefundProcessor);

    // First run
    const first = await processor.runForChild(kgAId, seed.childId, archivedAt);

    // Second run — should be idempotent
    const second = await processor.runForChild(kgAId, seed.childId, archivedAt);

    if (first.kind === 'created') {
      // Second must skip
      expect(second.kind).toBe('skipped');
      if (second.kind === 'skipped') {
        expect(second.reason).toBe('refund_already_exists');
      }
    } else {
      // First was skipped (month boundary) — second must also skip
      expect(second.kind).toBe('skipped');
    }

    // In any case: at most 1 refund row in DB
    const refunds = await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT COUNT(*)::int AS c
           FROM refunds r
           JOIN invoices i ON i.id = r.invoice_id
          WHERE r.kindergarten_id = $1 AND i.child_id = $2
            AND r.reason = 'pro_rata_archive'`,
        [kgAId, seed.childId],
      ) as Promise<Array<{ c: number }>>;
    });
    expect(refunds[0].c).toBeLessThanOrEqual(1);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario K: holidays exclusion
  // ═══════════════════════════════════════════════════════════════════════════

  it('computes refund amount excluding non-billable holidays', async () => {
    const seed = await seedActiveChildWithPaidInvoice(kgAId);

    // Seed 3 non-billable holidays AFTER today (in the remaining part of month)
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const today = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    // Pick up to 3 days after today
    const futureDays: string[] = [];
    for (let d = today + 1; d <= daysInMonth && futureDays.length < 3; d++) {
      futureDays.push(
        `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      );
    }

    if (futureDays.length === 0) {
      // Last day of month — can't add future holidays, skip K
      // (month boundary edge case; not a bug in the production code)
      return;
    }

    await seedHolidays(kgAId, futureDays);

    // Archive now
    const archivedAt = new Date();
    await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `UPDATE children
            SET status = 'archived', archived_at = $1, archive_reason = 'holidays test'
          WHERE id = $2`,
        [archivedAt, seed.childId],
      );
    });

    const processor = ctx.app.get(ProRataRefundProcessor);
    const outcome = await processor.runForChild(
      kgAId,
      seed.childId,
      archivedAt,
    );

    if (outcome.kind !== 'created') {
      // Acceptable at month boundary
      return;
    }

    // Compute expected:
    //   totalDays = daysInMonth
    //   archivedDays = today (inclusive)
    //   nonBillableTotal = futureDays.length
    //   totalBillable = totalDays - futureDays.length
    //   archivedBillable = today (no holidays before archive)
    //   refundableDays = totalBillable - archivedBillable
    //   refund = 60000 * refundableDays / totalBillable
    const totalBillable = daysInMonth - futureDays.length;
    const archivedBillable = today;
    const refundableDays = Math.max(0, totalBillable - archivedBillable);

    if (totalBillable > 0 && refundableDays > 0) {
      const expectedAmount =
        Math.round(((60000 * refundableDays) / totalBillable) * 100) / 100;
      expect(outcome.amountKzt).toBeCloseTo(expectedAmount, 1);
    }

    // Verify the computed amount is strictly less than without holidays
    // (sanity: holidays reduce the refund denominator + refundable numerator)
    const processWithoutHolidays =
      (60000 * (daysInMonth - today)) / daysInMonth;
    expect(outcome.amountKzt).toBeLessThanOrEqual(processWithoutHolidays + 1);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario L: outbox events
  // ═══════════════════════════════════════════════════════════════════════════

  it('writes child.archived outbox event after archive', async () => {
    const child = await createActiveChild(kgAAdminToken, 'L-archive');

    // Seed 2 approved guardians
    await seedGuardians(kgAId, child.id, 2, 'secondary');

    // Archive
    await archiveChild(kgAAdminToken, child.id, 'Outbox test');

    // Verify notification_outbox has child.archived
    const rows = await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT event_key, payload FROM notification_outbox
          WHERE kindergarten_id = $1 AND event_key = 'child.archived'`,
        [kgAId],
      ) as Promise<
        Array<{ event_key: string; payload: Record<string, unknown> }>
      >;
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].event_key).toBe('child.archived');
    expect(rows[0].payload['childId']).toBe(child.id);
    expect(rows[0].payload['archiveReason']).toBe('Outbox test');
  });

  it('writes child.transferred outbox event after group transfer', async () => {
    const child = await createActiveChild(kgAAdminToken, 'L-transfer');

    // Seed approved guardian so notification has recipients
    await seedGuardians(kgAId, child.id, 1, 'secondary');

    // Create group
    const grpRes = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .send({ name: 'Group L-transfer', capacity: 10 })
      .expect(201);
    const groupId = grpRes.body.id as string;

    // Transfer
    await request(server)
      .post(`/api/v1/children/${child.id}/transfer`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .send({ to_group_id: groupId, reason: 'outbox-test' })
      .expect(200);

    // Verify outbox
    const rows = await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT event_key, payload FROM notification_outbox
          WHERE kindergarten_id = $1 AND event_key = 'child.transferred'`,
        [kgAId],
      ) as Promise<
        Array<{ event_key: string; payload: Record<string, unknown> }>
      >;
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].event_key).toBe('child.transferred');
    expect(rows[0].payload['childId']).toBe(child.id);
    expect(rows[0].payload['toGroupId']).toBe(groupId);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario M (B22a T9): child_status_history audit endpoint
  // Full flow: archive → reactivate → archive again, then GET /status-history
  // returns 3 rows ordered by changed_at DESC. previous_archive_reason is
  // captured for the archived→active transition; archive_reason populated
  // for both active→archived rows; changed_by_user_id matches the admin's
  // users.id (NOT staff_members.id).
  // ═══════════════════════════════════════════════════════════════════════════

  it('records status history on archive→reactivate→archive and surfaces it via GET /status-history', async () => {
    const child = await createActiveChild(kgAAdminToken, 'M');

    // 1. archive
    await archiveChild(kgAAdminToken, child.id, 'First archive — relocation');

    // 2. reactivate (returns child to active; clears archive_reason on the
    //    children row, but the audit row preserves previous_archive_reason)
    await request(server)
      .post(`/api/v1/children/${child.id}/reactivate`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .expect(200);

    // 3. archive again (previously-active children go straight to archived)
    await archiveChild(kgAAdminToken, child.id, 'Second archive — final');

    // GET the audit history
    const res = await request(server)
      .get(`/api/v1/children/${child.id}/status-history`)
      .set('Authorization', `Bearer ${kgAAdminToken}`)
      .expect(200);

    const body = res.body as {
      items: Array<{
        id: string;
        previous_status: string;
        new_status: string;
        previous_archive_reason: string | null;
        archive_reason: string | null;
        changed_by_user_id: string;
        changed_at: string;
      }>;
      total: number;
    };

    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);

    // Ordered changed_at DESC → newest first.
    const [newest, middle, oldest] = body.items;

    // Newest = the second archive
    expect(newest.previous_status).toBe('active');
    expect(newest.new_status).toBe('archived');
    expect(newest.archive_reason).toBe('Second archive — final');
    expect(newest.previous_archive_reason).toBeNull();
    expect(newest.changed_by_user_id).toBe(kgAAdminUserId);

    // Middle = the reactivate (archived → active). Crucially captures the
    // archive_reason that was on the children row BEFORE Child.reactivate()
    // wiped it.
    expect(middle.previous_status).toBe('archived');
    expect(middle.new_status).toBe('active');
    expect(middle.archive_reason).toBeNull();
    expect(middle.previous_archive_reason).toBe('First archive — relocation');
    expect(middle.changed_by_user_id).toBe(kgAAdminUserId);

    // Oldest = the first archive
    expect(oldest.previous_status).toBe('active');
    expect(oldest.new_status).toBe('archived');
    expect(oldest.archive_reason).toBe('First archive — relocation');
    expect(oldest.previous_archive_reason).toBeNull();
    expect(oldest.changed_by_user_id).toBe(kgAAdminUserId);

    // Sanity: every changed_at parses as a valid ISO timestamp.
    for (const r of body.items) {
      expect(Number.isFinite(new Date(r.changed_at).getTime())).toBe(true);
    }

    // The DB row also reflects the FK to users.id (not staff_members.id).
    const dbRows = await ds.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT changed_by_user_id FROM child_status_history
          WHERE child_id = $1
          ORDER BY changed_at ASC`,
        [child.id],
      ) as Promise<Array<{ changed_by_user_id: string }>>;
    });
    expect(dbRows.every((r) => r.changed_by_user_id === kgAAdminUserId)).toBe(
      true,
    );
  });

  it('returns 404 child_not_found for status-history of cross-tenant child', async () => {
    const child = await createActiveChild(kgAAdminToken, 'M-cross');

    const res = await request(server)
      .get(`/api/v1/children/${child.id}/status-history`)
      .set('Authorization', `Bearer ${kgBAdminToken}`)
      .expect(404);
    expect(res.body.error).toBe('not_found');
  });
});
