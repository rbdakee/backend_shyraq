import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import { AllConfigType } from '@/config/config.type';
import { NotificationPort } from '@/common/notifications/notification.port';
import { OtpInvalidError } from '@/modules/auth/domain/errors/otp-invalid.error';
import { OtpExpiredError } from '@/modules/auth/domain/errors/otp-expired.error';
import { OtpLockedError } from '@/modules/auth/domain/errors/otp-locked.error';
import { OtpRateLimitedError } from '@/modules/auth/domain/errors/otp-rate-limited.error';
import { OtpStorePort } from '@/modules/auth/otp-store.port';
import { SmsPort } from '@/modules/auth/sms.port';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { TrustedPersonRepository } from '@/modules/pickup/infrastructure/persistence/trusted-person.repository';
import { PickupRequestRepository } from '@/modules/pickup/infrastructure/persistence/pickup-request.repository';
import { StaffRole } from '@/modules/staff/domain/entities/staff-member.entity';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { isWeekendDay } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import {
  ParentRequest,
  ParentRequestRecipientType,
  ParentRequestStatus,
  ParentRequestType,
} from './domain/entities/parent-request.entity';
import { ParentRequestMessage } from './domain/entities/parent-request-message.entity';
import {
  CreateRequestPermissionRequiredError,
  ParentRequestAlreadyProcessedError,
  ParentRequestForbiddenError,
  ParentRequestNotFoundError,
} from './domain/errors';
import {
  ListParentRequestsFilter,
  ParentRequestRepository,
} from './parent-request.repository';
import { ParentRequestMessageRepository } from './parent-request-message.repository';
import { ParentRequestOtpStorePort } from './infrastructure/otp/parent-request-otp-store.port';
import { parentRequestOtpTemplate } from './infrastructure/sms/parent-request-sms.templates';
import {
  InvariantViolationError,
  NotFoundError,
} from '@/shared-kernel/domain/errors';

const PARENT_REQUEST_OTP_TTL_SEC = 300;
const PARENT_REQUEST_OTP_LOCK_TTL_SEC = 15 * 60;
const PARENT_REQUEST_OTP_MAX_FAILED_ATTEMPTS = 3;

const CREATE_RATE_LIMIT_PER_HOUR = 30;
const CREATE_RATE_LIMIT_WINDOW_SEC = 60 * 60;

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface CallerStaffContext {
  staffMemberId: string;
  userId: string;
  role: StaffRole;
}

export interface SendOtpResult {
  otpRef: string;
  expiresIn: number;
}

export interface CreateTrustedPersonRequestInput {
  code: string;
  childId: string;
  fullName: string;
  phone: string;
  iin: string | null;
  relation: string;
  photoUrl: string | null;
  isOneTime: boolean;
  createPickupRequest: boolean;
  comment: string | null;
}

export interface CreateDayOffRequestInput {
  childId: string;
  weekendDates: string[];
  comment: string | null;
}

export interface CreateVacationRequestInput {
  childId: string;
  dateFrom: string;
  dateTo: string;
  comment: string | null;
}

export interface CreateLatePickupRequestInput {
  childId: string;
  date: string;
  expectedTime: string;
  comment: string | null;
}

export interface CreateOpenRequestInput {
  childId: string;
  recipientType: 'admin' | 'mentor' | 'specialist';
  recipientStaffId: string | null;
  subject: string;
  message: string;
  attachments: string[] | null;
}

export interface AddMessageInput {
  body: string;
  attachments: string[] | null;
}

export interface ListMessagesResult {
  items: ParentRequestMessage[];
  nextCursor: string | null;
}

export interface ListParentRequestsResult {
  items: ParentRequest[];
  nextCursor: string | null;
}

/**
 * ParentRequestService — orchestrates the B12 parent-request flow:
 *
 *   pending ──accept──▶ accepted   (terminal)
 *      │
 *      ├─reject──────▶ rejected   (terminal)
 *      │
 *      └─cancel──────▶ cancelled  (terminal — parent-initiated)
 *
 * Conditional UPDATE pattern (inherited from db8cb72 #6 + B11 T7-5): every
 * transition runs `UPDATE … WHERE status='pending' RETURNING *` so two
 * concurrent staff hits cannot both flip the row — losers map to 409
 * `parent_request_already_processed`.
 *
 * OTP integration: `trusted_person` requests require pre-verification of the
 * trusted person's phone via /otp-request → /trusted-person. The code is
 * keyed by `requesterUserId` under namespace `otp:request:trusted-person`,
 * while the per-phone rate-limit budget is shared with auth's `rate:otp:`
 * window so abusing this endpoint cannot earn extra login OTP budget.
 *
 * Transactionality: side-effect writes inside `acceptRequest` (TrustedPerson
 * + optional PickupRequest creation) live on the ambient HTTP TX set up by
 * `TenantContextInterceptor` — no inner `dataSource.transaction(...)`. If
 * any side-effect throws, the conditional UPDATE rolls back cleanly.
 */
@Injectable()
export class ParentRequestService {
  private readonly logger = new Logger(ParentRequestService.name);

  constructor(
    private readonly parentRequests: ParentRequestRepository,
    private readonly messages: ParentRequestMessageRepository,
    private readonly childGuardians: ChildGuardianRepository,
    private readonly childRepo: ChildRepository,
    private readonly staffRepo: StaffMemberRepository,
    private readonly groupRepo: GroupRepository,
    private readonly trustedPeople: TrustedPersonRepository,
    private readonly pickupRequests: PickupRequestRepository,
    private readonly parentRequestOtp: ParentRequestOtpStorePort,
    @Inject(OtpStorePort) private readonly authOtpStore: OtpStorePort,
    @Inject(SmsPort) private readonly sms: SmsPort,
    @Inject(NotificationPort) private readonly notifications: NotificationPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
    private readonly configService: ConfigService<AllConfigType>,
  ) {}

  // ── OTP for trusted-person flow ───────────────────────────────────────

  async sendOtpForTrustedPerson(
    kindergartenId: string,
    requesterUserId: string,
    childId: string,
    phone: string,
  ): Promise<SendOtpResult> {
    await this.assertCreateRequestsAllowed(
      kindergartenId,
      childId,
      requesterUserId,
    );

    if (await this.parentRequestOtp.isLocked(requesterUserId)) {
      throw new OtpLockedError();
    }

    // Per-phone rate-limit shared with auth login (one phone = one budget).
    // T3 — order matters: lock check FIRST (Redis GET), then rate-limit
    // (consumes a slot). Mirrors B11 PickupRequestService.sendOtp.
    const limit = this.configService.getOrThrow(
      'auth.rateLimitOtpRequestLimit',
      { infer: true },
    );
    const window = this.configService.getOrThrow(
      'auth.rateLimitOtpRequestWindowSec',
      { infer: true },
    );
    const state = await this.authOtpStore.checkRateLimit(phone, limit, window);
    if (state === 'exceeded') {
      throw new OtpRateLimitedError();
    }

    const code = generateSixDigitCode();
    const otpRef = await this.parentRequestOtp.storeCode(
      requesterUserId,
      code,
      PARENT_REQUEST_OTP_TTL_SEC,
    );

    await this.sms.send(
      phone,
      parentRequestOtpTemplate(code, 'trusted_person'),
    );

    return { otpRef, expiresIn: PARENT_REQUEST_OTP_TTL_SEC };
  }

  // ── Create — per type ─────────────────────────────────────────────────

  async createTrustedPersonRequest(
    kindergartenId: string,
    requesterUserId: string,
    input: CreateTrustedPersonRequestInput,
  ): Promise<ParentRequest> {
    await this.assertCreateRequestsAllowed(
      kindergartenId,
      input.childId,
      requesterUserId,
    );
    await this.assertCreateRateLimit(requesterUserId);

    // Verify-and-clear OTP atomically. Lock-out / wrong / expired surface
    // the auth-module errors so client behaviour is consistent with login.
    await this.consumeTrustedPersonOtp(requesterUserId, input.code);

    const details = {
      full_name: input.fullName,
      phone: input.phone,
      iin: input.iin,
      relation: input.relation,
      photo_url: input.photoUrl,
      is_one_time: input.isOneTime,
      create_pickup_request: input.createPickupRequest,
      comment: input.comment,
    };

    return this.parentRequests.create({
      kindergartenId,
      childId: input.childId,
      requesterUserId,
      requestType: 'trusted_person',
      dateFrom: null,
      dateTo: null,
      details,
      recipientType: 'admin',
      recipientStaffId: null,
    });
  }

  async createDayOffRequest(
    kindergartenId: string,
    requesterUserId: string,
    input: CreateDayOffRequestInput,
  ): Promise<ParentRequest> {
    await this.assertCreateRequestsAllowed(
      kindergartenId,
      input.childId,
      requesterUserId,
    );
    await this.assertCreateRateLimit(requesterUserId);

    const dates = parseAndValidateWeekendDates(
      input.weekendDates,
      this.clock.now(),
    );

    const recipient = await this.resolveMentorRecipient(
      kindergartenId,
      input.childId,
    );

    const details = {
      weekend_dates: dates.map(toIsoDateString),
      comment: input.comment,
    };

    return this.parentRequests.create({
      kindergartenId,
      childId: input.childId,
      requesterUserId,
      requestType: 'day_off',
      dateFrom: null,
      dateTo: null,
      details,
      recipientType: recipient.type,
      recipientStaffId: recipient.staffMemberId,
    });
  }

  async createVacationRequest(
    kindergartenId: string,
    requesterUserId: string,
    input: CreateVacationRequestInput,
  ): Promise<ParentRequest> {
    await this.assertCreateRequestsAllowed(
      kindergartenId,
      input.childId,
      requesterUserId,
    );
    await this.assertCreateRateLimit(requesterUserId);

    const today = startOfUtcDay(this.clock.now());
    const dateFrom = parseIsoDate(input.dateFrom, 'date_from');
    const dateTo = parseIsoDate(input.dateTo, 'date_to');
    if (dateFrom.getTime() < today.getTime()) {
      throw new InvariantViolationError('parent_request_date_from_in_past');
    }
    if (dateTo.getTime() < dateFrom.getTime()) {
      throw new InvariantViolationError('parent_request_date_range_invalid');
    }

    const recipient = await this.resolveMentorRecipient(
      kindergartenId,
      input.childId,
    );

    return this.parentRequests.create({
      kindergartenId,
      childId: input.childId,
      requesterUserId,
      requestType: 'vacation',
      dateFrom,
      dateTo,
      details: { comment: input.comment },
      recipientType: recipient.type,
      recipientStaffId: recipient.staffMemberId,
    });
  }

  async createLatePickupRequest(
    kindergartenId: string,
    requesterUserId: string,
    input: CreateLatePickupRequestInput,
  ): Promise<ParentRequest> {
    await this.assertCreateRequestsAllowed(
      kindergartenId,
      input.childId,
      requesterUserId,
    );
    await this.assertCreateRateLimit(requesterUserId);

    if (!TIME_REGEX.test(input.expectedTime)) {
      throw new InvariantViolationError('parent_request_expected_time_invalid');
    }
    const today = startOfUtcDay(this.clock.now());
    const date = parseIsoDate(input.date, 'date');
    if (date.getTime() < today.getTime()) {
      throw new InvariantViolationError('parent_request_date_in_past');
    }

    const recipient = await this.resolveMentorRecipient(
      kindergartenId,
      input.childId,
    );

    return this.parentRequests.create({
      kindergartenId,
      childId: input.childId,
      requesterUserId,
      requestType: 'late_pickup',
      dateFrom: date,
      dateTo: null,
      details: {
        expected_time: input.expectedTime,
        comment: input.comment,
      },
      recipientType: recipient.type,
      recipientStaffId: recipient.staffMemberId,
    });
  }

  async createOpenRequest(
    kindergartenId: string,
    requesterUserId: string,
    input: CreateOpenRequestInput,
  ): Promise<ParentRequest> {
    await this.assertCreateRequestsAllowed(
      kindergartenId,
      input.childId,
      requesterUserId,
    );
    await this.assertCreateRateLimit(requesterUserId);

    let recipientType: ParentRequestRecipientType = input.recipientType;
    let recipientStaffId: string | null = input.recipientStaffId;

    if (input.recipientType === 'specialist') {
      // specialist must be named — the parent picks from the kg's specialist
      // list. We reject "specialist" without a target rather than silently
      // routing to admin.
      if (!recipientStaffId) {
        throw new InvariantViolationError(
          'parent_request_recipient_staff_required',
        );
      }
      const staff = await this.staffRepo.findById(
        kindergartenId,
        recipientStaffId,
      );
      if (!staff || staff.kindergartenId !== kindergartenId) {
        throw new NotFoundError('staff_member', recipientStaffId);
      }
      if (staff.role !== 'specialist') {
        throw new InvariantViolationError(
          'parent_request_recipient_role_mismatch',
        );
      }
    } else if (input.recipientType === 'mentor') {
      // Either the parent named a mentor explicitly (we validate they are
      // a mentor in this kg) OR we fall back to the child's group mentor.
      if (recipientStaffId) {
        const staff = await this.staffRepo.findById(
          kindergartenId,
          recipientStaffId,
        );
        if (!staff || staff.kindergartenId !== kindergartenId) {
          throw new NotFoundError('staff_member', recipientStaffId);
        }
        if (staff.role !== 'mentor') {
          throw new InvariantViolationError(
            'parent_request_recipient_role_mismatch',
          );
        }
      } else {
        const recipient = await this.resolveMentorRecipient(
          kindergartenId,
          input.childId,
        );
        recipientType = recipient.type;
        recipientStaffId = recipient.staffMemberId;
      }
    } else {
      // recipientType === 'admin' — recipientStaffId is always null (any admin
      // in the kg picks it up via inbox; explicit assignment is not modeled).
      recipientStaffId = null;
    }

    return this.parentRequests.create({
      kindergartenId,
      childId: input.childId,
      requesterUserId,
      requestType: 'open_request',
      dateFrom: null,
      dateTo: null,
      details: {
        subject: input.subject,
        message: input.message,
        attachments: input.attachments ?? null,
      },
      recipientType,
      recipientStaffId,
    });
  }

  // ── Cancel / Accept / Reject ──────────────────────────────────────────

  async cancelRequest(
    kindergartenId: string,
    requesterUserId: string,
    parentRequestId: string,
  ): Promise<ParentRequest> {
    // Ownership check FIRST — distinguishes 404 vs 403 cleanly without
    // relying on the conditional UPDATE's 0-row branch. The conditional
    // UPDATE then only has to handle the race vs concurrent staff
    // accept/reject (which manifests as 409 already_processed).
    const existing = await this.parentRequests.findById(
      parentRequestId,
      kindergartenId,
    );
    if (!existing) {
      throw new ParentRequestNotFoundError(parentRequestId);
    }
    if (existing.requesterUserId !== requesterUserId) {
      throw new ParentRequestForbiddenError();
    }

    const now = this.clock.now();
    const updated = await this.parentRequests.updateStatusConditional(
      parentRequestId,
      kindergartenId,
      'pending',
      'cancelled',
      { updatedAt: now },
    );
    if (!updated) {
      throw new ParentRequestAlreadyProcessedError(parentRequestId);
    }

    await this.notifications.notifyParentRequestCancelled({
      kindergartenId,
      parentRequestId: updated.id,
      childId: updated.childId,
      requesterUserId: updated.requesterUserId,
      requestType: updated.requestType,
      recipientStaffId: updated.recipientStaffId,
      recipientStaffUserId: await this.resolveStaffUserId(
        kindergartenId,
        updated.recipientStaffId,
      ),
    });
    return updated;
  }

  async acceptRequest(
    kindergartenId: string,
    caller: CallerStaffContext,
    parentRequestId: string,
    reviewNote: string | null,
  ): Promise<ParentRequest> {
    const existing = await this.parentRequests.findById(
      parentRequestId,
      kindergartenId,
    );
    if (!existing) {
      throw new ParentRequestNotFoundError(parentRequestId);
    }
    this.assertStaffCanReview(existing, caller);

    const now = this.clock.now();
    const updated = await this.parentRequests.updateStatusConditional(
      parentRequestId,
      kindergartenId,
      'pending',
      'accepted',
      {
        reviewedBy: caller.staffMemberId,
        reviewedAt: now,
        reviewNote: reviewNote ?? null,
        updatedAt: now,
      },
    );
    if (!updated) {
      throw new ParentRequestAlreadyProcessedError(parentRequestId);
    }

    // Per-type side effects — all run on the ambient HTTP TX set up by
    // TenantContextInterceptor. If any throw, the surrounding TX rolls back
    // and the conditional UPDATE reverts cleanly.
    switch (updated.requestType) {
      case 'trusted_person':
        await this.applyTrustedPersonAcceptSideEffects(updated, caller);
        break;
      case 'day_off':
        // TODO(B22): include accepted day_off weekend dates in expected
        // attendance (AttendanceService::markExpected on the weekend dates).
        break;
      case 'vacation':
        // TODO(B22): batch-mark child_daily_status='on_vacation' on
        // accept(vacation) for the inclusive [date_from..date_to] range.
        break;
      case 'late_pickup':
        // TODO(B13): emit late-pickup invoice on accept (tariff snapshot
        // already lives in details.expected_time; B13 will add a
        // late_pickup_tariff_kzt field to kindergartens and project the
        // invoice row here).
        break;
      case 'open_request':
        // No additional side-effects beyond notify.
        break;
    }

    await this.notifications.notifyParentRequestAccepted({
      kindergartenId,
      parentRequestId: updated.id,
      childId: updated.childId,
      requesterUserId: updated.requesterUserId,
      requestType: updated.requestType,
      reviewedByStaffId: caller.staffMemberId,
    });

    this.logger.log(
      `parent_request.accepted id=${updated.id} kg=${kindergartenId} type=${updated.requestType} by=${caller.staffMemberId}`,
    );
    return updated;
  }

  async rejectRequest(
    kindergartenId: string,
    caller: CallerStaffContext,
    parentRequestId: string,
    reviewNote: string | null,
  ): Promise<ParentRequest> {
    const existing = await this.parentRequests.findById(
      parentRequestId,
      kindergartenId,
    );
    if (!existing) {
      throw new ParentRequestNotFoundError(parentRequestId);
    }
    this.assertStaffCanReview(existing, caller);

    const now = this.clock.now();
    const updated = await this.parentRequests.updateStatusConditional(
      parentRequestId,
      kindergartenId,
      'pending',
      'rejected',
      {
        reviewedBy: caller.staffMemberId,
        reviewedAt: now,
        reviewNote: reviewNote ?? null,
        updatedAt: now,
      },
    );
    if (!updated) {
      throw new ParentRequestAlreadyProcessedError(parentRequestId);
    }

    await this.notifications.notifyParentRequestRejected({
      kindergartenId,
      parentRequestId: updated.id,
      childId: updated.childId,
      requesterUserId: updated.requesterUserId,
      requestType: updated.requestType,
      reviewedByStaffId: caller.staffMemberId,
    });
    return updated;
  }

  // ── Thread (messages) ─────────────────────────────────────────────────

  async addParentMessage(
    kindergartenId: string,
    requesterUserId: string,
    parentRequestId: string,
    input: AddMessageInput,
  ): Promise<ParentRequestMessage> {
    const pr = await this.parentRequests.findById(
      parentRequestId,
      kindergartenId,
    );
    if (!pr) {
      throw new ParentRequestNotFoundError(parentRequestId);
    }
    if (pr.requesterUserId !== requesterUserId) {
      throw new ParentRequestForbiddenError();
    }

    const message = await this.messages.create({
      kindergartenId,
      parentRequestId: pr.id,
      authorUserId: requesterUserId,
      authorStaffId: null,
      body: input.body,
      attachments: input.attachments,
    });

    await this.notifications.notifyParentRequestMessageSent({
      kindergartenId,
      parentRequestId: pr.id,
      childId: pr.childId,
      messageId: message.id,
      authorRole: 'parent',
      authorUserId: requesterUserId,
      authorStaffId: null,
      requesterUserId: pr.requesterUserId,
      recipientStaffId: pr.recipientStaffId,
      recipientStaffUserId: await this.resolveStaffUserId(
        kindergartenId,
        pr.recipientStaffId,
      ),
    });

    return message;
  }

  async addStaffMessage(
    kindergartenId: string,
    caller: CallerStaffContext,
    parentRequestId: string,
    input: AddMessageInput,
  ): Promise<ParentRequestMessage> {
    const pr = await this.parentRequests.findById(
      parentRequestId,
      kindergartenId,
    );
    if (!pr) {
      throw new ParentRequestNotFoundError(parentRequestId);
    }
    this.assertStaffCanReview(pr, caller);

    const message = await this.messages.create({
      kindergartenId,
      parentRequestId: pr.id,
      authorUserId: null,
      authorStaffId: caller.staffMemberId,
      body: input.body,
      attachments: input.attachments,
    });

    await this.notifications.notifyParentRequestMessageSent({
      kindergartenId,
      parentRequestId: pr.id,
      childId: pr.childId,
      messageId: message.id,
      authorRole: 'staff',
      authorUserId: null,
      authorStaffId: caller.staffMemberId,
      requesterUserId: pr.requesterUserId,
      recipientStaffId: pr.recipientStaffId,
      recipientStaffUserId: await this.resolveStaffUserId(
        kindergartenId,
        pr.recipientStaffId,
      ),
    });

    return message;
  }

  async listMessagesForParent(
    kindergartenId: string,
    requesterUserId: string,
    parentRequestId: string,
    limit: number,
    cursor: string | null,
  ): Promise<ListMessagesResult> {
    const pr = await this.parentRequests.findById(
      parentRequestId,
      kindergartenId,
    );
    if (!pr) {
      throw new ParentRequestNotFoundError(parentRequestId);
    }
    if (pr.requesterUserId !== requesterUserId) {
      throw new ParentRequestForbiddenError();
    }
    return this.listMessagesInternal(kindergartenId, pr.id, limit, cursor);
  }

  async listMessagesForStaff(
    kindergartenId: string,
    caller: CallerStaffContext,
    parentRequestId: string,
    limit: number,
    cursor: string | null,
  ): Promise<ListMessagesResult> {
    const pr = await this.parentRequests.findById(
      parentRequestId,
      kindergartenId,
    );
    if (!pr) {
      throw new ParentRequestNotFoundError(parentRequestId);
    }
    this.assertStaffCanReview(pr, caller);
    return this.listMessagesInternal(kindergartenId, pr.id, limit, cursor);
  }

  // ── List/get views ────────────────────────────────────────────────────

  async listForParent(
    kindergartenId: string,
    requesterUserId: string,
    filter: {
      status?: ParentRequestStatus;
      type?: ParentRequestType;
      childId?: string;
      limit?: number;
      cursor?: string | null;
    },
  ): Promise<ListParentRequestsResult> {
    const limit = clampLimit(filter.limit, 50, 100);
    const items = await this.parentRequests.list({
      kindergartenId,
      requesterUserId,
      status: filter.status,
      requestType: filter.type,
      childId: filter.childId,
      limit: limit + 1,
      cursor: filter.cursor ?? undefined,
    });
    return shapePage(items, limit);
  }

  async listForStaffInbox(
    kindergartenId: string,
    caller: CallerStaffContext,
    filter: {
      status?: ParentRequestStatus;
      type?: ParentRequestType;
      groupId?: string;
      childId?: string;
      limit?: number;
      cursor?: string | null;
    },
  ): Promise<ListParentRequestsResult> {
    const limit = clampLimit(filter.limit, 50, 100);
    // Admin sees everything in the kg; mentor sees their direct queue;
    // specialist sees their direct queue. Mentor + specialist DO NOT see
    // `admin`-recipient requests by default — those land in the admin inbox.
    const baseFilter: ListParentRequestsFilter = {
      kindergartenId,
      status: filter.status,
      requestType: filter.type,
      childId: filter.childId,
      limit: limit + 1,
      cursor: filter.cursor ?? undefined,
    };

    if (caller.role === 'admin') {
      const items = await this.parentRequests.list(baseFilter);
      return shapePage(items, limit);
    }

    if (caller.role === 'mentor' || caller.role === 'specialist') {
      const items = await this.parentRequests.list({
        ...baseFilter,
        recipientStaffId: caller.staffMemberId,
      });
      return shapePage(items, limit);
    }

    // Other roles (reception) — empty for now.
    return { items: [], nextCursor: null };
  }

  async listAllForAdmin(
    kindergartenId: string,
    filter: {
      status?: ParentRequestStatus;
      type?: ParentRequestType;
      childId?: string;
      groupId?: string;
      recipientType?: 'admin' | 'mentor' | 'specialist';
      limit?: number;
      cursor?: string | null;
    },
  ): Promise<ListParentRequestsResult> {
    const limit = clampLimit(filter.limit, 50, 100);
    const items = await this.parentRequests.list({
      kindergartenId,
      status: filter.status,
      requestType: filter.type,
      childId: filter.childId,
      recipientType: filter.recipientType,
      limit: limit + 1,
      cursor: filter.cursor ?? undefined,
    });
    return shapePage(items, limit);
  }

  async getByIdForParent(
    kindergartenId: string,
    requesterUserId: string,
    parentRequestId: string,
  ): Promise<ParentRequest> {
    const pr = await this.parentRequests.findById(
      parentRequestId,
      kindergartenId,
    );
    if (!pr) {
      throw new ParentRequestNotFoundError(parentRequestId);
    }
    if (pr.requesterUserId !== requesterUserId) {
      throw new ParentRequestForbiddenError();
    }
    return pr;
  }

  async getByIdForStaff(
    kindergartenId: string,
    caller: CallerStaffContext,
    parentRequestId: string,
  ): Promise<ParentRequest> {
    const pr = await this.parentRequests.findById(
      parentRequestId,
      kindergartenId,
    );
    if (!pr) {
      throw new ParentRequestNotFoundError(parentRequestId);
    }
    this.assertStaffCanReview(pr, caller);
    return pr;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async listMessagesInternal(
    kindergartenId: string,
    parentRequestId: string,
    limit: number,
    cursor: string | null,
  ): Promise<ListMessagesResult> {
    const clamped = clampLimit(limit, 50, 200);
    const items = await this.messages.listByRequestId(
      parentRequestId,
      kindergartenId,
      clamped + 1,
      cursor,
    );
    if (items.length > clamped) {
      const page = items.slice(0, clamped);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor: last.toState().createdAt.toISOString(),
      };
    }
    return { items, nextCursor: null };
  }

  /**
   * Single source of truth for "this caller has the create_requests
   * permission on THIS child". Throws `ParentRequestForbiddenError` (404 vs
   * 403 — we use 403 generic since the parent could otherwise discover
   * which kg owns a child by error-shape diff) when the link is missing,
   * and `CreateRequestPermissionRequiredError` when the link exists but
   * `permissions.effective(role).create_requests !== true`.
   */
  private async assertCreateRequestsAllowed(
    kindergartenId: string,
    childId: string,
    requesterUserId: string,
  ): Promise<void> {
    const link = await this.childGuardians.findApprovedActiveByUserAndChild(
      kindergartenId,
      childId,
      requesterUserId,
    );
    if (!link) {
      throw new ParentRequestForbiddenError();
    }
    const effective = link.permissions.effective(link.role);
    if (effective.create_requests !== true) {
      throw new CreateRequestPermissionRequiredError();
    }
  }

  private async assertCreateRateLimit(requesterUserId: string): Promise<void> {
    const key = `rate:parent_requests:create:${requesterUserId}`;
    const state = await this.authOtpStore.checkRateLimitGeneric(
      key,
      CREATE_RATE_LIMIT_PER_HOUR,
      CREATE_RATE_LIMIT_WINDOW_SEC,
    );
    if (state === 'exceeded') {
      throw new OtpRateLimitedError();
    }
  }

  private async consumeTrustedPersonOtp(
    requesterUserId: string,
    submitted: string,
  ): Promise<void> {
    if (await this.parentRequestOtp.isLocked(requesterUserId)) {
      throw new OtpLockedError();
    }
    const stored = await this.parentRequestOtp.readCode(requesterUserId);
    if (!stored) {
      throw new OtpExpiredError();
    }
    if (stored.code === submitted) {
      await this.parentRequestOtp.clearCode(requesterUserId);
      return;
    }
    const attempts =
      await this.parentRequestOtp.incrementAttempts(requesterUserId);
    if (attempts >= PARENT_REQUEST_OTP_MAX_FAILED_ATTEMPTS) {
      await this.parentRequestOtp.lockUser(
        requesterUserId,
        PARENT_REQUEST_OTP_LOCK_TTL_SEC,
      );
      await this.parentRequestOtp.clearCode(requesterUserId);
      throw new OtpLockedError();
    }
    throw new OtpInvalidError();
  }

  /**
   * Resolve the recipient for a request type whose default routing is the
   * child's group mentor (day_off, vacation, late_pickup, open_request when
   * the parent did not name a specific staff member). When no active mentor
   * exists for the group (or the child has no group) we fall back to admin.
   */
  private async resolveMentorRecipient(
    kindergartenId: string,
    childId: string,
  ): Promise<{
    type: 'admin' | 'mentor';
    staffMemberId: string | null;
  }> {
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (!child) {
      throw new ChildNotFoundError(childId);
    }
    if (!child.currentGroupId) {
      return { type: 'admin', staffMemberId: null };
    }
    const mentor = await this.groupRepo.findActiveMentor(
      kindergartenId,
      child.currentGroupId,
    );
    if (!mentor) {
      return { type: 'admin', staffMemberId: null };
    }
    return { type: 'mentor', staffMemberId: mentor.staffMemberId };
  }

  /**
   * Authorisation gate for staff actions on a parent_request. Admin may
   * touch anything in the kg. Mentor may touch requests routed to their
   * staff_member_id. Specialist may touch requests routed to their own
   * staff_member_id.
   */
  private assertStaffCanReview(
    pr: ParentRequest,
    caller: CallerStaffContext,
  ): void {
    if (caller.role === 'admin') return;
    if (caller.role === 'mentor' || caller.role === 'specialist') {
      if (pr.recipientStaffId === caller.staffMemberId) return;
    }
    throw new ParentRequestForbiddenError();
  }

  /**
   * Side-effect for `accept(trusted_person)` — insert the trusted_people row
   * (whitelist) and (when `details.create_pickup_request === true`) also
   * insert a paired pickup_requests row linked via parent_request_id. Runs
   * on the ambient HTTP TX so failure rolls back the conditional UPDATE.
   */
  private async applyTrustedPersonAcceptSideEffects(
    pr: ParentRequest,
    caller: CallerStaffContext,
  ): Promise<void> {
    const details = pr.details;
    const fullName = stringDetail(details, 'full_name', '');
    const phone = stringDetail(details, 'phone', '');
    const iin = nullableStringDetail(details, 'iin');
    const relation = stringDetail(details, 'relation', 'guardian');
    const photoUrl = nullableStringDetail(details, 'photo_url');
    const isOneTime = booleanDetail(details, 'is_one_time', false);
    const createPickupRequest = booleanDetail(
      details,
      'create_pickup_request',
      false,
    );

    if (!fullName || !phone) {
      // Defensive — DTO validation already ensured these. If the row was
      // hand-edited or upgraded from a prior schema we'd rather fail loudly
      // than silently insert a half-baked trusted_people row.
      throw new InvariantViolationError(
        'parent_request_trusted_person_details_invalid',
      );
    }

    const tp = await this.trustedPeople.create({
      kindergartenId: pr.kindergartenId,
      childId: pr.childId,
      addedByUserId: pr.requesterUserId,
      fullName,
      phone,
      iin,
      relation,
      photoUrl,
      isOneTime,
    });

    if (createPickupRequest) {
      const now = this.clock.now();
      const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
      await this.pickupRequests.create({
        kindergartenId: pr.kindergartenId,
        childId: pr.childId,
        // Acceptance was performed by staff; the parent originally requested
        // the trusted_person flow but the pickup_request itself is created
        // on the parent's behalf — we credit the parent (requester) so push
        // recipients line up with B11 conventions.
        requestedByUserId: pr.requesterUserId,
        trustedPersonId: tp.id,
        trustedPersonPhone: tp.phone,
        trustedPersonName: tp.fullName,
        trustedPersonIin: tp.iin,
        expiresAt,
        parentRequestId: pr.id,
      });
      this.logger.log(
        `parent_request.trusted_person_pickup_chained pr=${pr.id} tp=${tp.id} kg=${pr.kindergartenId} by_staff=${caller.staffMemberId}`,
      );
    }
  }

  /**
   * Resolve the user_id for a staff_member id, returning null when the
   * staff_member id itself is null or the row is missing. Used by the
   * notification producers to populate `recipientStaffUserId` so the
   * dispatcher does not need a StaffMemberRepository dep.
   */
  private async resolveStaffUserId(
    kindergartenId: string,
    staffMemberId: string | null,
  ): Promise<string | null> {
    if (!staffMemberId) return null;
    const staff = await this.staffRepo.findById(kindergartenId, staffMemberId);
    return staff ? staff.userId : null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function generateSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function parseIsoDate(s: string, fieldLabel: string): Date {
  if (!ISO_DATE_REGEX.test(s)) {
    throw new InvariantViolationError(`parent_request_${fieldLabel}_invalid`);
  }
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new InvariantViolationError(`parent_request_${fieldLabel}_invalid`);
  }
  return d;
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function toIsoDateString(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Domain validation for `day_off.weekend_dates`:
 *   - 1 or 2 entries (DTO already enforces)
 *   - each ISO-formatted (DTO enforces)
 *   - each must fall on Sat or Sun
 *   - none in the past
 *   - if 2 — both in the same calendar week (Mon-anchored) so the parent
 *     cannot stage two consecutive weekends with one create
 */
function parseAndValidateWeekendDates(rawDates: string[], now: Date): Date[] {
  if (rawDates.length === 0 || rawDates.length > 2) {
    throw new InvariantViolationError(
      'parent_request_weekend_dates_count_invalid',
    );
  }
  const today = startOfUtcDay(now);
  const dates = rawDates.map((s) => parseIsoDate(s, 'weekend_dates'));
  for (const d of dates) {
    if (d.getTime() < today.getTime()) {
      throw new InvariantViolationError('parent_request_weekend_date_in_past');
    }
    if (!isWeekendDay(d)) {
      throw new InvariantViolationError(
        'parent_request_weekend_date_not_weekend',
      );
    }
  }
  if (dates.length === 2) {
    const mondayA = mondayOfIsoWeek(dates[0]);
    const mondayB = mondayOfIsoWeek(dates[1]);
    if (mondayA.getTime() !== mondayB.getTime()) {
      throw new InvariantViolationError(
        'parent_request_weekend_dates_different_weeks',
      );
    }
  }
  return dates;
}

/**
 * Returns the UTC midnight of the Monday anchoring the ISO week of `d`.
 * Sat (iso=6) → Mon = d-5; Sun (iso=7) → Mon = d-6.
 */
function mondayOfIsoWeek(d: Date): Date {
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  const daysSinceMonday = isoDay - 1;
  const ms = d.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000;
  return new Date(ms);
}

function clampLimit(
  raw: number | undefined,
  fallback: number,
  max: number,
): number {
  if (raw === undefined || raw === null || Number.isNaN(raw)) return fallback;
  if (raw < 1) return 1;
  if (raw > max) return max;
  return Math.floor(raw);
}

function shapePage<T>(
  items: T[],
  limit: number,
): {
  items: T[];
  nextCursor: string | null;
} {
  if (items.length > limit) {
    const page = items.slice(0, limit);
    // Cursor placeholder — the relational repo's list() does NOT yet honour
    // a cursor (B12 T2 left it as a passthrough). Emitting null keeps the
    // contract honest: clients that hit `next_cursor=null` know there is no
    // more. T4/B22 may add a real cursor when the dataset gets large.
    return { items: page, nextCursor: null };
  }
  return { items, nextCursor: null };
}

function stringDetail(
  details: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const v = details[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function nullableStringDetail(
  details: Record<string, unknown>,
  key: string,
): string | null {
  const v = details[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function booleanDetail(
  details: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const v = details[key];
  return typeof v === 'boolean' ? v : fallback;
}
