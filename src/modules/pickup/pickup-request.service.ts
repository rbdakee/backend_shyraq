import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import { AllConfigType } from '@/config/config.type';
import { NotificationPort } from '@/common/notifications/notification.port';
import { OtpExpiredError } from '@/modules/auth/domain/errors/otp-expired.error';
import { OtpInvalidError } from '@/modules/auth/domain/errors/otp-invalid.error';
import { OtpLockedError } from '@/modules/auth/domain/errors/otp-locked.error';
import { OtpRateLimitedError } from '@/modules/auth/domain/errors/otp-rate-limited.error';
import { OtpStorePort } from '@/modules/auth/otp-store.port';
import { SmsPort } from '@/modules/auth/sms.port';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { KindergartenRepository } from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ForbiddenActionError } from '@/shared-kernel/domain/errors';
import { AttendanceService } from '@/modules/attendance/attendance.service';
import { AttendanceMethod } from '@/modules/attendance/domain/value-objects/attendance-method.vo';
import { PickupRequest } from './domain/entities/pickup-request.entity';
import { PickupRequestAlreadyValidatedError } from './domain/errors/pickup-request-already-validated.error';
import { PickupRequestExpiredError } from './domain/errors/pickup-request-expired.error';
import { PickupRequestNotFoundError } from './domain/errors/pickup-request-not-found.error';
import { PickupRequestStatusInvalidError } from './domain/errors/pickup-request-status-invalid.error';
import { TrustedPersonNotForChildError } from './domain/errors/trusted-person-not-for-child.error';
import { TrustedPersonNotFoundError } from './domain/errors/trusted-person-not-found.error';
import { TrustedPersonRevokedError } from './domain/errors/trusted-person-revoked.error';
import { PickupOtpStorePort } from './infrastructure/otp/pickup-otp-store.port';
import { pickupOtpTemplate } from './infrastructure/sms/pickup-sms.templates';
import {
  ListPickupFilters,
  PickupRequestRepository,
} from './infrastructure/persistence/pickup-request.repository';
import { TrustedPersonRepository } from './infrastructure/persistence/trusted-person.repository';

const PICKUP_OTP_TTL_SEC = 30 * 60; // 30 minutes — also the request deadline
const PICKUP_OTP_LOCK_TTL_SEC = 15 * 60;
const PICKUP_OTP_MAX_FAILED_ATTEMPTS = 3;

export interface CreatePickupRequestInput {
  childId: string;
  trustedPersonId: string | null;
  trustedPersonName?: string;
  trustedPersonPhone?: string;
  trustedPersonIin?: string | null;
}

export interface SendOtpResult {
  otpRef: string;
  expiresIn: number;
}

export interface ValidateOtpResult {
  pickupRequest: PickupRequest;
  attendanceEventId: string;
}

/**
 * PickupRequestService — orchestrates the B11 staff-side OTP-pickup flow
 * AND the parent-side request creation. The aggregate flips through
 *
 *   otp_sent ──validateOtp──► validated   (terminal — attendance row created)
 *      │
 *      ├──cancel───────────► cancelled    (staff aborts before validate)
 *      │
 *      └──expire───────────► expired      (deadline passed; lazy)
 *
 * OTP storage is split deliberately: the code itself lives at
 * `otp:pickup:{requestId}` so two concurrent requests for the same
 * trusted-person phone don't collide; the rate-limit budget piggy-backs
 * on auth's per-phone window so abusing pickup OTP can't earn extra login
 * budget for free.
 *
 * Validate + cancel both grab `pg_advisory_xact_lock` keyed on the request
 * id so a network retry, two staff devices, OR a concurrent
 * cancel-vs-validate cannot both transition the status and either produce
 * two attendance_events or roll back a successful validate to cancelled.
 * The HTTP-layer ambient TX (set up by `TenantContextInterceptor`) carries
 * both the GUC for RLS and the advisory lock; we deliberately do NOT open
 * an inner `dataSource.transaction(...)` here — that wasted a pool
 * connection AND let the inner TX's lock release at the inner COMMIT
 * before the surrounding side-effects had committed. T7 collapsed the
 * inner TX so the lock now lives on the ambient TX for its full lifetime.
 */
@Injectable()
export class PickupRequestService {
  private readonly logger = new Logger(PickupRequestService.name);

  constructor(
    private readonly pickupRequests: PickupRequestRepository,
    private readonly trustedPeople: TrustedPersonRepository,
    private readonly childGuardians: ChildGuardianRepository,
    private readonly childRepo: ChildRepository,
    private readonly kindergartenRepo: KindergartenRepository,
    private readonly staffRepo: StaffMemberRepository,
    private readonly otpStore: PickupOtpStorePort,
    @Inject(OtpStorePort) private readonly authOtpStore: OtpStorePort,
    @Inject(SmsPort) private readonly sms: SmsPort,
    @Inject(NotificationPort) private readonly notifications: NotificationPort,
    @Inject(forwardRef(() => AttendanceService))
    private readonly attendance: AttendanceService,
    @Inject(ClockPort) private readonly clock: ClockPort,
    private readonly configService: ConfigService<AllConfigType>,
  ) {}

  // ── List / get ─────────────────────────────────────────────────────────

  async listByKindergarten(
    kindergartenId: string,
    filters: Omit<ListPickupFilters, 'kindergartenId'>,
  ): Promise<PickupRequest[]> {
    return this.pickupRequests.listByKindergarten({
      kindergartenId,
      groupId: filters.groupId ?? null,
      status: filters.status ?? null,
    });
  }

  async getById(
    kindergartenId: string,
    requestId: string,
  ): Promise<PickupRequest> {
    const pr = await this.pickupRequests.findById(requestId);
    if (!pr || pr.kindergartenId !== kindergartenId) {
      throw new PickupRequestNotFoundError(requestId);
    }
    return pr;
  }

  // ── Create — staff branch ──────────────────────────────────────────────

  async createByStaff(
    kindergartenId: string,
    callerUserId: string,
    input: CreatePickupRequestInput,
  ): Promise<PickupRequest> {
    // Validate child + ensure caller is staff in this kg.
    await this.assertChildExists(kindergartenId, input.childId);
    const staff = await this.staffRepo.findActiveByUserAndKindergarten(
      callerUserId,
      kindergartenId,
    );
    if (!staff) throw new StaffNotFoundError(callerUserId);

    return this.createInternal(kindergartenId, callerUserId, input);
  }

  // ── Create — parent branch ─────────────────────────────────────────────

  async createByParent(
    kindergartenId: string,
    parentUserId: string,
    input: CreatePickupRequestInput,
  ): Promise<PickupRequest> {
    await this.assertChildExists(kindergartenId, input.childId);

    // Parent must have an approved-active guardian link with can_pickup=true
    // for THIS child. Reuses the B8 attendance precondition so semantics
    // match (you can only initiate a pickup for a child you yourself could
    // pick up directly).
    const guardian = await this.childGuardians.findApprovedActivePickupGuardian(
      kindergartenId,
      input.childId,
      parentUserId,
    );
    if (!guardian) {
      throw new ForbiddenActionError(
        'parent_not_authorized_for_pickup',
        'You do not have permission to initiate pickup for this child',
      );
    }

    return this.createInternal(kindergartenId, parentUserId, input);
  }

  // ── send-otp ───────────────────────────────────────────────────────────

  async sendOtp(
    kindergartenId: string,
    requestId: string,
  ): Promise<SendOtpResult> {
    // T7-4 MEDIUM: sendOtp must serialize with concurrent cancel/validate
    // on the same request id. Without the advisory lock there is a race
    // window:
    //   1. sendOtp (A) reads status='otp_sent'
    //   2. cancel/validate (B) acquires advisory lock → flips status to
    //      terminal (cancelled/validated) → clears Redis → COMMIT
    //   3. sendOtp (A) writes Redis + sends SMS + emits notification for a
    //      now-terminal request (worst case: SMS delivered + outbox row
    //      written for cancelled/validated request).
    //
    // Acquiring the same `pickup:validate:{requestId}` lock here makes
    // sendOtp wait behind a concurrent cancel/validate (and vice versa),
    // so we observe the post-flip status and surface 409 cleanly.
    // Lock lives on the ambient HTTP TX — released at controller-level
    // COMMIT/ROLLBACK alongside the Redis writes + DB update + SMS call.
    await this.pickupRequests.acquireValidateAdvisoryLock(requestId);

    const pr = await this.pickupRequests.findByIdForUpdate(requestId);
    if (!pr || pr.kindergartenId !== kindergartenId) {
      throw new PickupRequestNotFoundError(requestId);
    }
    if (pr.status !== 'otp_sent') {
      throw new PickupRequestStatusInvalidError(
        pr.status,
        'otp_sent',
        'send_otp',
      );
    }
    const now = this.clock.now();
    if (pr.isExpired(now)) {
      // Deadline already passed — surface as state-invalid so the caller
      // creates a fresh request instead of retrying this one. Status flip
      // to `expired` is left to the cleanup job (T6).
      throw new PickupRequestStatusInvalidError(
        pr.status,
        'otp_sent',
        'send_otp',
      );
    }

    // Order matters: per-request lock check FIRST (free, in-memory Redis
    // GET), then per-phone rate-limit (consumes a slot in the shared auth
    // budget). T7 fix M4: the previous order let a locked request burn
    // rate-limit slots that legitimate auth-login flows on the same phone
    // would later need, opening a cross-flow griefing vector.
    if (await this.otpStore.isLocked(requestId)) {
      throw new OtpLockedError();
    }

    // Per-phone rate-limit shared with auth login (one phone = one budget).
    const limit = this.configService.getOrThrow(
      'auth.rateLimitOtpRequestLimit',
      { infer: true },
    );
    const window = this.configService.getOrThrow(
      'auth.rateLimitOtpRequestWindowSec',
      { infer: true },
    );
    const state = await this.authOtpStore.checkRateLimit(
      pr.trustedPersonPhone,
      limit,
      window,
    );
    if (state === 'exceeded') {
      throw new OtpRateLimitedError();
    }

    const code = generateSixDigitCode();
    const redisKey = await this.otpStore.storeCode(
      requestId,
      code,
      PICKUP_OTP_TTL_SEC,
    );
    await this.pickupRequests.update(requestId, { otpRef: redisKey });

    // SMS body needs human-readable child + kg names. Both lookups are
    // best-effort — a missing row should not block OTP delivery because
    // at this point the request itself is real and the trusted person is
    // already on their way. T7 fix M2: child lookup is now best-effort
    // too (was throwing 404 silently for a window where the pickup
    // request row outlived a just-archived child) — symmetry with the
    // kindergarten lookup below.
    const child = await this.childRepo
      .findById(kindergartenId, pr.childId)
      .catch(() => null);
    const childName = child?.fullName ?? 'ребёнок';
    const kg = await this.kindergartenRepo
      .findById(kindergartenId)
      .catch(() => null);
    const kgName = kg?.name ?? 'детский сад';

    await this.sms.send(
      pr.trustedPersonPhone,
      pickupOtpTemplate(code, childName, kgName),
    );

    await this.notifications.notifyPickupOtpSent({
      kindergartenId,
      childId: pr.childId,
      pickupRequestId: pr.id,
      requesterUserId: pr.requestedByUserId,
      trustedPersonName: pr.trustedPersonName,
    });

    return { otpRef: redisKey, expiresIn: PICKUP_OTP_TTL_SEC };
  }

  // ── validate-otp ───────────────────────────────────────────────────────

  async validateOtp(
    kindergartenId: string,
    requestId: string,
    code: string,
    callerUserId: string,
  ): Promise<ValidateOtpResult> {
    // Pre-resolve caller staff before grabbing the advisory lock so a
    // missing staff surfaces as 404 without holding the lock for nothing.
    const staff = await this.staffRepo.findActiveByUserAndKindergarten(
      callerUserId,
      kindergartenId,
    );
    if (!staff) throw new StaffNotFoundError(callerUserId);

    // Everything below runs on the ambient HTTP TX (set up by
    // `TenantContextInterceptor`). The advisory lock therefore lives on
    // the same TX as the side-effect writes — released only at the
    // controller-level COMMIT/ROLLBACK. T7 fix H2: previously this body
    // opened an inner `dataSource.transaction(...)` which (a) consumed an
    // extra pool connection per validate, (b) released the lock at the
    // inner COMMIT before the outer notifications/log lines ran, and
    // (c) confused readers about which TX state the GUC for RLS was set
    // on. Now: lock + read-for-update + side-effects all share the
    // ambient TX.
    await this.pickupRequests.acquireValidateAdvisoryLock(requestId);

    const pr = await this.pickupRequests.findByIdForUpdate(requestId);
    if (!pr || pr.kindergartenId !== kindergartenId) {
      throw new PickupRequestNotFoundError(requestId);
    }

    const now = this.clock.now();
    // Pre-check the state-machine guards explicitly so the OTP store I/O
    // below isn't wasted on a doomed request. The domain `validate(...)`
    // call at the end re-enforces these before stamping.
    if (pr.status === 'validated') {
      throw new PickupRequestAlreadyValidatedError();
    }
    if (pr.status !== 'otp_sent') {
      throw new PickupRequestStatusInvalidError(
        pr.status,
        'otp_sent',
        'validate',
      );
    }
    if (pr.isExpired(now)) {
      throw new PickupRequestExpiredError();
    }

    if (await this.otpStore.isLocked(requestId)) {
      throw new OtpLockedError();
    }

    const stored = await this.otpStore.readCode(requestId);
    if (!stored) {
      throw new OtpExpiredError();
    }

    if (stored.code !== code) {
      const attempts = await this.otpStore.incrementAttempts(requestId);
      if (attempts >= PICKUP_OTP_MAX_FAILED_ATTEMPTS) {
        await this.otpStore.lockRequest(requestId, PICKUP_OTP_LOCK_TTL_SEC);
        await this.otpStore.clearCode(requestId);
        throw new OtpLockedError();
      }
      throw new OtpInvalidError();
    }

    // Code accepted. T7 fix M3: DB writes BEFORE Redis clearCode. If the
    // attendance check-out throws (FK violation, attendance-rule
    // violation, …) the ambient TX rolls back AND the OTP code is still
    // in Redis — staff/network can retry validate without the trusted
    // person re-dictating a fresh code. Replay protection on success now
    // relies on the `pr.status === 'validated'` guard above (terminal
    // state ⇒ `PickupRequestAlreadyValidatedError` on retry).
    //
    // Order:
    //   1. attendance.checkOut       — may throw; advisory lock still held
    //   2. pickupRequests.update     — flip status to validated
    //   3. trustedPeople.markUsed    — stamp used_at + deactivate one-time
    //   4. otpStore.clearCode        — Redis cleanup (post-DB)
    //   5. notifications.notifyPickupValidated — outbox row, atomic
    //
    // 1) Side-effect: attendance check-out under the OTP-pickup branch.
    //    AttendanceService accepts pickupUserId=null + pickupRequestId so
    //    it skips the pickup-guardian assertion (already gated by us).
    const checkout = await this.attendance.checkOut(
      kindergartenId,
      pr.childId,
      callerUserId,
      null,
      {
        method: AttendanceMethod.OTP_PICKUP,
        pickupRequestId: requestId,
        recordedAt: now,
      },
    );

    // 2) Flip the pickup_request state-machine.
    const validated = pr.validate(staff.id, checkout.event.id, now);
    await this.pickupRequests.update(requestId, {
      status: validated.status,
      validatedBy: validated.validatedBy,
      validatedAt: validated.validatedAt,
      attendanceEventId: validated.attendanceEventId,
    });

    // 3) If the trusted person came from the whitelist, stamp `used_at`
    //    (and deactivate when one-time).
    if (pr.trustedPersonId) {
      const tp = await this.trustedPeople.findById(pr.trustedPersonId);
      if (tp) {
        await this.trustedPeople.markUsed(tp.id, now, tp.isOneTime);
      }
    }

    // 4) Cleanup Redis OTP entry — post-DB so a transient checkOut
    //    failure cannot silently consume the code.
    await this.otpStore.clearCode(requestId);

    // 5) Outbox notification — atomic with the writes (same TX).
    await this.notifications.notifyPickupValidated({
      kindergartenId,
      childId: pr.childId,
      pickupRequestId: pr.id,
      requesterUserId: pr.requestedByUserId,
      trustedPersonName: pr.trustedPersonName,
      attendanceEventId: checkout.event.id,
      validatedAt: now,
    });

    this.logger.log(
      `pickup.validated request=${requestId} kg=${kindergartenId} child=${pr.childId} attendance=${checkout.event.id}`,
    );

    return {
      pickupRequest: validated,
      attendanceEventId: checkout.event.id,
    };
  }

  // ── cancel ─────────────────────────────────────────────────────────────

  async cancel(
    kindergartenId: string,
    requestId: string,
  ): Promise<PickupRequest> {
    // T7 fix H3: cancel must serialize with concurrent validateOtp on the
    // same request id. Without the advisory lock we have a lost-update
    // window: validate reads `otp_sent`, cancel reads `otp_sent`, both
    // pass their state-machine guards, then validate flips to `validated`
    // (writes attendance row), cancel flips to `cancelled` (overwriting
    // validated). Acquiring the same `pickup:validate:{requestId}` lock
    // here makes cancel wait behind a concurrent validate (and vice
    // versa), so we observe the post-validate `validated` status and
    // surface 409 `pickup_request_status_invalid` cleanly.
    //
    // Defense-in-depth: we ALSO pass `expectedStatus: 'otp_sent'` to the
    // repo update so the SQL UPDATE filters `WHERE status = 'otp_sent'`
    // — if some other path ever transitions the row out of band the
    // 0-row-affected branch maps back to the same state-invalid error.
    await this.pickupRequests.acquireValidateAdvisoryLock(requestId);

    const pr = await this.pickupRequests.findByIdForUpdate(requestId);
    if (!pr || pr.kindergartenId !== kindergartenId) {
      throw new PickupRequestNotFoundError(requestId);
    }
    const now = this.clock.now();
    const cancelled = pr.cancel(now);
    const updated = await this.pickupRequests.update(
      requestId,
      { status: cancelled.status },
      { expectedStatus: 'otp_sent' },
    );
    if (!updated) {
      // Some concurrent path beat us out of `otp_sent`. Read back to find
      // the actual current status and surface the same conflict the entity
      // guard would have produced.
      const fresh = await this.pickupRequests.findById(requestId);
      throw new PickupRequestStatusInvalidError(
        fresh?.status ?? 'unknown',
        'otp_sent',
        'cancel',
      );
    }
    // T7 fix H5: clearCode unconditionally. The previous `otpRef !== null`
    // guard was a leak vector — a request that was created but never had
    // send-otp called still doesn't have an `otpRef`, but a later send-otp
    // attempt could have written a key just before cancel acquired the
    // lock (race against the in-flight send). Redis DEL is idempotent so
    // an extra DEL on an empty key is free.
    await this.otpStore.clearCode(requestId);
    return cancelled;
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async createInternal(
    kindergartenId: string,
    requestedByUserId: string,
    input: CreatePickupRequestInput,
  ): Promise<PickupRequest> {
    let phone: string;
    let name: string;
    let iin: string | null;
    let trustedPersonId: string | null = null;

    if (input.trustedPersonId) {
      const tp = await this.trustedPeople.findById(input.trustedPersonId);
      if (!tp) {
        throw new TrustedPersonNotFoundError(input.trustedPersonId);
      }
      if (
        tp.kindergartenId !== kindergartenId ||
        tp.childId !== input.childId
      ) {
        throw new TrustedPersonNotForChildError();
      }
      if (!tp.isAvailableForPickup()) {
        throw new TrustedPersonRevokedError();
      }
      phone = tp.phone;
      name = tp.fullName;
      iin = tp.iin;
      trustedPersonId = tp.id;
    } else {
      // Ad-hoc — DTO validation guarantees the snapshot fields are set when
      // trusted_person_id is null. Defensive runtime checks anyway.
      if (!input.trustedPersonName || input.trustedPersonName.length === 0) {
        throw new ForbiddenActionError(
          'trusted_person_name_required',
          'trusted_person_name is required for ad-hoc pickup',
        );
      }
      if (!input.trustedPersonPhone || input.trustedPersonPhone.length === 0) {
        throw new ForbiddenActionError(
          'trusted_person_phone_required',
          'trusted_person_phone is required for ad-hoc pickup',
        );
      }
      phone = input.trustedPersonPhone;
      name = input.trustedPersonName;
      iin = input.trustedPersonIin ?? null;
    }

    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + PICKUP_OTP_TTL_SEC * 1000);

    return this.pickupRequests.create({
      kindergartenId,
      childId: input.childId,
      requestedByUserId,
      trustedPersonId,
      trustedPersonPhone: phone,
      trustedPersonName: name,
      trustedPersonIin: iin,
      expiresAt,
      parentRequestId: null,
    });
  }

  private async assertChildExists(
    kindergartenId: string,
    childId: string,
  ): Promise<void> {
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (!child) {
      throw new ChildNotFoundError(childId);
    }
  }
}

function generateSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
