import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { PushNotificationPort } from '@/shared-kernel/domain/push-notification.port';
import { OutboxEvent } from './domain/entities/outbox-event.entity';
import {
  NotificationCreateInput,
  NotificationRepository,
} from './notification.repository';
import { NotificationPreferenceRepository } from './notification-preference.repository';
import { classifyPushError } from './push-error-classifier';
import { PushTokenRepository } from './push-token.repository';
import { WsBroadcaster } from './ws-broadcaster.port';

/**
 * Outcome of a single dispatcher run. The worker (T6) reads `status` to
 * decide between `markDispatched` (terminal success) and
 * `markFailedWithRetry` (transient — schedule retry, or terminal failed).
 */
export type DispatchResult =
  | { status: 'dispatched' }
  | { status: 'failed'; reason: string };

interface ResolvedRecipients {
  /** Distinct user-ids to fan-out to. */
  userIds: string[];
  /**
   * For each user, whether they are a `nanny` guardian on the underlying
   * child. Used by `applyNannyPolicy` — nannies are restricted to the
   * `attendance.*` and `pickup.*` event-keys.
   */
  nannyUserIds: Set<string>;
  /** Optional fan-out room ids for WS — informational, not used yet by T4. */
  childId?: string;
  groupId?: string;
}

interface NotificationTemplateArgs {
  payload: Record<string, unknown>;
  /**
   * Optional dispatcher-side enrichment (childName, groupName, requesterName).
   * Resolved per event-key by `enrichTemplateContext` BEFORE the template is
   * invoked. Falls back to short generic strings ("ребёнок", "группа") when
   * a lookup fails or the row was deleted between enqueue and dispatch — we
   * never want a missing display name to fail the whole event.
   */
  enrichment: TemplateEnrichment;
}

interface TemplateEnrichment {
  childName: string;
  groupName: string;
  newGuardianName: string;
}

interface NotificationTemplateResult {
  titleI18n: Record<string, string>;
  bodyI18n: Record<string, string>;
  /**
   * FCM-data is string-only — every value here must be a string. The
   * dispatcher passes this object verbatim into the push payload.
   */
  data: Record<string, string>;
}

type EventTemplate = (
  args: NotificationTemplateArgs,
) => NotificationTemplateResult;

type RecipientResolver = (
  event: OutboxEvent,
  deps: { guardianRepo: ChildGuardianRepository },
) => Promise<ResolvedRecipients>;

/**
 * Set of event-keys nannies are allowed to receive. Anything outside this
 * set is silently dropped for users with `role='nanny'` on the underlying
 * child. `pickup.*` keys land here in B11; B9 leaves the placeholder so
 * nanny pickup notifications work without follow-up.
 *
 * `child.transferred` and `guardian.permissions_updated` are deliberately
 * excluded — they are administrative / parent-facing events. `guardian.*`
 * self-events about the nanny themselves (pending_approval, rejected,
 * revoked, self_revoked, approved) bypass the nanny filter because their
 * recipient is a single user-id and the resolver returns an empty
 * `nannyUserIds` set.
 */
const NANNY_ALLOWED_EVENT_KEYS = new Set<string>([
  'attendance.checkin',
  'attendance.checkout',
  'pickup.otp_sent',
  'pickup.validated',
]);

/**
 * Sentinel error thrown by `dispatch()` when the run terminates in `failed`
 * status. The worker's per-event savepoint catches it, rolls the savepoint
 * back (so any history rows / preference upserts written inside the
 * savepoint revert), and then routes to `markFailedWithRetry` against the
 * OUTER manager — exactly the same code path used for unhandled exceptions
 * inside the dispatcher.
 *
 * Why throw instead of return: the savepoint commits when the inner block
 * resolves, even if the resolved value is `{status:'failed'}`. With
 * history-row inserts now living inside the savepoint, a return-failed
 * would leave duplicate history rows on retry. Throwing forces the
 * savepoint rollback so the next attempt re-inserts cleanly.
 */
export class SavepointRollback extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SavepointRollback';
  }
}

const FALLBACK_ENRICHMENT: TemplateEnrichment = {
  childName: 'ребёнок',
  groupName: 'группа',
  newGuardianName: 'новый опекун',
};

const TEMPLATES: Record<string, EventTemplate> = {
  'attendance.checkin': ({ payload }) => ({
    titleI18n: {
      ru: 'Ребёнок прибыл в сад',
      kk: 'Бала балабақшаға келді',
      en: 'Child checked in',
    },
    bodyI18n: {
      ru: 'Регистрация прихода зафиксирована.',
      kk: 'Келу уақыты тіркелді.',
      en: 'Check-in recorded.',
    },
    data: stringMap({
      childId: payload.childId,
      eventId: payload.eventId,
      recordedAt: payload.recordedAt,
    }),
  }),

  'attendance.checkout': ({ payload }) => ({
    titleI18n: {
      ru: 'Ребёнок забран из сада',
      kk: 'Бала балабақшадан алынды',
      en: 'Child checked out',
    },
    bodyI18n: {
      ru: 'Регистрация ухода зафиксирована.',
      kk: 'Кету уақыты тіркелді.',
      en: 'Check-out recorded.',
    },
    data: stringMap({
      childId: payload.childId,
      eventId: payload.eventId,
      pickupUserId: payload.pickupUserId,
    }),
  }),

  'daily_status.changed': ({ payload }) => ({
    titleI18n: {
      ru: 'Статус ребёнка обновлён',
      kk: 'Баланың статусы жаңартылды',
      en: 'Daily status updated',
    },
    bodyI18n: {
      ru: `Новый статус: ${String(payload.status ?? '')}`,
      kk: `Жаңа статус: ${String(payload.status ?? '')}`,
      en: `New status: ${String(payload.status ?? '')}`,
    },
    data: stringMap({
      childId: payload.childId,
      date: payload.date,
      status: payload.status,
    }),
  }),

  'timeline.entry_created': ({ payload }) => ({
    titleI18n: {
      ru: 'Новая запись в ленте',
      kk: 'Жаңа жазба қосылды',
      en: 'New timeline entry',
    },
    bodyI18n: {
      ru: `Тип: ${String(payload.entryType ?? '')}`,
      kk: `Түрі: ${String(payload.entryType ?? '')}`,
      en: `Type: ${String(payload.entryType ?? '')}`,
    },
    data: stringMap({
      childId: payload.childId,
      entryId: payload.entryId,
      entryType: payload.entryType,
    }),
  }),

  'guardian.approved': ({ payload }) => ({
    titleI18n: {
      ru: 'Доступ к ребёнку подтверждён',
      kk: 'Балаға қол жетімділік расталды',
      en: 'Guardian access approved',
    },
    bodyI18n: {
      ru: 'Вам предоставлен доступ как опекуну.',
      kk: 'Сізге қамқоршы ретінде қолжетімділік берілді.',
      en: 'You now have guardian access.',
    },
    data: stringMap({
      childId: payload.childId,
      guardianUserId: payload.guardianUserId,
    }),
  }),

  'guardian.self_revoked': ({ payload }) => ({
    titleI18n: {
      ru: 'Связь с ребёнком отозвана',
      kk: 'Баламен байланыс жойылды',
      en: 'Guardian link removed',
    },
    bodyI18n: {
      ru: 'Вы отвязались от ребёнка.',
      kk: 'Сіз баладан байланысыңызды үздіңіз.',
      en: 'You unlinked from the child.',
    },
    data: stringMap({
      childId: payload.childId,
      userId: payload.userId,
    }),
  }),

  // ── B9 follow-up: cover the rest of NotificationPort surface ─────────────

  'guardian.pending_approval': ({ payload, enrichment }) => {
    // `childFullName` lives in payload from the producer (`child.service`)
    // — fall back through enrichment.childName for safety. `newGuardianName`
    // is enrichment-only (resolver looks up the requester user).
    const childName =
      asNonEmptyString(payload.childFullName) ?? enrichment.childName;
    const requesterName = enrichment.newGuardianName;
    return {
      titleI18n: {
        ru: 'Новый опекун ждёт одобрения',
        kk: 'Жаңа қамқоршы мақұлдауды күтуде',
        en: 'New guardian pending approval',
      },
      bodyI18n: {
        ru: `${requesterName} хочет присоединиться к ребёнку ${childName}.`,
        kk: `${requesterName} ${childName} баласына қосылғысы келеді.`,
        en: `${requesterName} wants to join child ${childName}.`,
      },
      data: stringMap({
        childId: payload.childId,
        primaryUserId: payload.primaryUserId,
        requesterUserId: payload.requesterUserId,
        role: payload.role,
      }),
    };
  },

  'guardian.rejected': ({ payload, enrichment }) => ({
    titleI18n: {
      ru: 'Запрос отклонён',
      kk: 'Сұраным қабылданбады',
      en: 'Request rejected',
    },
    bodyI18n: {
      ru: `Ваш запрос на присоединение к ребёнку ${enrichment.childName} отклонён.`,
      kk: `${enrichment.childName} баласына қосылу сұранымыңыз қабылданбады.`,
      en: `Your request to join child ${enrichment.childName} was rejected.`,
    },
    data: stringMap({
      childId: payload.childId,
      guardianUserId: payload.guardianUserId,
      rejectedBy: payload.rejectedBy,
    }),
  }),

  'guardian.revoked': ({ payload, enrichment }) => ({
    titleI18n: {
      ru: 'Доступ отозван',
      kk: 'Қол жеткізу қайтарып алынды',
      en: 'Access revoked',
    },
    bodyI18n: {
      ru: `Ваш доступ к ребёнку ${enrichment.childName} отозван.`,
      kk: `${enrichment.childName} баласына қол жеткізуіңіз қайтарып алынды.`,
      en: `Your access to child ${enrichment.childName} was revoked.`,
    },
    data: stringMap({
      childId: payload.childId,
      guardianUserId: payload.guardianUserId,
      revokedBy: payload.revokedBy,
    }),
  }),

  'child.transferred': ({ payload, enrichment }) => ({
    titleI18n: {
      ru: 'Ребёнок переведён',
      kk: 'Бала ауыстырылды',
      en: 'Child transferred',
    },
    bodyI18n: {
      ru: `${enrichment.childName} переведён в группу ${enrichment.groupName}.`,
      kk: `${enrichment.childName} ${enrichment.groupName} тобына ауыстырылды.`,
      en: `${enrichment.childName} was transferred to group ${enrichment.groupName}.`,
    },
    data: stringMap({
      childId: payload.childId,
      fromGroupId: payload.fromGroupId,
      toGroupId: payload.toGroupId,
      transferredBy: payload.transferredBy,
    }),
  }),

  'guardian.permissions_updated': ({ payload, enrichment }) => ({
    titleI18n: {
      ru: 'Права обновлены',
      kk: 'Құқықтар жаңартылды',
      en: 'Permissions updated',
    },
    bodyI18n: {
      ru: `Ваши права для ребёнка ${enrichment.childName} обновлены.`,
      kk: `${enrichment.childName} баласына қатысты құқықтарыңыз жаңартылды.`,
      en: `Your permissions for child ${enrichment.childName} have been updated.`,
    },
    data: stringMap({
      childId: payload.childId,
      guardianUserId: payload.guardianUserId,
      updatedBy: payload.updatedBy,
    }),
  }),

  // ── B11 Pickup OTP ─────────────────────────────────────────────────────

  'pickup.otp_sent': ({ payload, enrichment }) => {
    const trustedName =
      asNonEmptyString(payload.trustedPersonName) ?? 'доверенному лицу';
    return {
      titleI18n: {
        ru: 'Код отправлен доверенному лицу',
        kk: 'Сенімді тұлғаға код жіберілді',
        en: 'Pickup code sent',
      },
      bodyI18n: {
        ru: `Код для забора ребёнка ${enrichment.childName} отправлен ${trustedName}.`,
        kk: `${enrichment.childName} баласын алу үшін код ${trustedName} тұлғасына жіберілді.`,
        en: `Pickup code for ${enrichment.childName} sent to ${trustedName}.`,
      },
      data: stringMap({
        childId: payload.childId,
        pickupRequestId: payload.pickupRequestId,
        requesterUserId: payload.requesterUserId,
      }),
    };
  },

  'pickup.validated': ({ payload, enrichment }) => {
    const trustedName =
      asNonEmptyString(payload.trustedPersonName) ?? 'доверенному лицу';
    return {
      titleI18n: {
        ru: 'Ребёнок передан доверенному лицу',
        kk: 'Бала сенімді тұлғаға берілді',
        en: 'Child handed over',
      },
      bodyI18n: {
        ru: `${enrichment.childName} передан(а) — ${trustedName}.`,
        kk: `${enrichment.childName} ${trustedName} тұлғасына берілді.`,
        en: `${enrichment.childName} handed over to ${trustedName}.`,
      },
      data: stringMap({
        childId: payload.childId,
        pickupRequestId: payload.pickupRequestId,
        attendanceEventId: payload.attendanceEventId,
        validatedAt: payload.validatedAt,
      }),
    };
  },

  // ── B12 Parent-request events ─────────────────────────────────────────
  // Generic Russian copy — clients render type-specific UI from `requestType`
  // in the data payload. Nannies do NOT receive request.* (excluded by the
  // NANNY_ALLOWED_EVENT_KEYS gate — they only get attendance.* + pickup.*).

  'request.accepted': ({ payload }) => ({
    titleI18n: {
      ru: 'Заявка принята',
      kk: 'Өтінім қабылданды',
      en: 'Request accepted',
    },
    bodyI18n: {
      ru: 'Сотрудник принял вашу заявку.',
      kk: 'Қызметкер сіздің өтініміңізді қабылдады.',
      en: 'Your request was accepted by the staff.',
    },
    data: stringMap({
      parentRequestId: payload.parentRequestId,
      childId: payload.childId,
      requestType: payload.requestType,
      reviewedByStaffId: payload.reviewedByStaffId,
    }),
  }),

  'request.rejected': ({ payload }) => ({
    titleI18n: {
      ru: 'Заявка отклонена',
      kk: 'Өтінім қабылданбады',
      en: 'Request rejected',
    },
    bodyI18n: {
      ru: 'Сотрудник отклонил вашу заявку.',
      kk: 'Қызметкер сіздің өтініміңізді қабылдамады.',
      en: 'Your request was rejected by the staff.',
    },
    data: stringMap({
      parentRequestId: payload.parentRequestId,
      childId: payload.childId,
      requestType: payload.requestType,
      reviewedByStaffId: payload.reviewedByStaffId,
    }),
  }),

  'request.cancelled': ({ payload }) => ({
    titleI18n: {
      ru: 'Заявка отменена',
      kk: 'Өтінім жойылды',
      en: 'Request cancelled',
    },
    bodyI18n: {
      ru: 'Родитель отменил заявку.',
      kk: 'Ата-ана өтінімді жойды.',
      en: 'The parent cancelled the request.',
    },
    data: stringMap({
      parentRequestId: payload.parentRequestId,
      childId: payload.childId,
      requestType: payload.requestType,
    }),
  }),

  'request.message_sent': ({ payload }) => ({
    titleI18n: {
      ru: 'Новое сообщение по заявке',
      kk: 'Өтінім бойынша жаңа хабарлама',
      en: 'New message on request',
    },
    bodyI18n: {
      ru: 'Открыть, чтобы прочитать и ответить.',
      kk: 'Оқу және жауап беру үшін ашыңыз.',
      en: 'Open to read and reply.',
    },
    data: stringMap({
      parentRequestId: payload.parentRequestId,
      childId: payload.childId,
      messageId: payload.messageId,
      authorRole: payload.authorRole,
    }),
  }),

  // ── B13 Billing & Invoices ─────────────────────────────────────────────
  // Generic copy keyed by amount + due date — clients render the
  // child / invoice context from the data payload. Nannies are excluded
  // from every billing event by `applyNannyPolicy` (NANNY_ALLOWED_EVENT_KEYS
  // only covers attendance.* + pickup.*).

  'invoice.created': ({ payload }) => {
    const amount = formatAmount(payload.amountAfterDiscount);
    const dueDate = asNonEmptyString(payload.dueDate) ?? '';
    return {
      titleI18n: {
        ru: 'Новый счёт',
        kk: 'Жаңа шот',
        en: 'New invoice',
      },
      bodyI18n: {
        ru: `Создан счёт на сумму ${amount} ₸ до ${dueDate}.`,
        kk: `Жаңа шот: ${amount} ₸, ${dueDate}-ге дейін.`,
        en: `Invoice issued: ${amount} ₸, due ${dueDate}.`,
      },
      data: stringMap({
        invoiceId: payload.invoiceId,
        childId: payload.childId,
        invoiceType: payload.invoiceType,
        amountAfterDiscount: payload.amountAfterDiscount,
        dueDate: payload.dueDate,
      }),
    };
  },

  'invoice.paid': ({ payload }) => {
    const amount = formatAmount(payload.amountAfterDiscount);
    return {
      titleI18n: {
        ru: 'Счёт оплачен',
        kk: 'Шот төленді',
        en: 'Invoice paid',
      },
      bodyI18n: {
        ru: `Счёт на сумму ${amount} ₸ оплачен.`,
        kk: `Шот төленді: ${amount} ₸.`,
        en: `Invoice ${amount} ₸ paid.`,
      },
      data: stringMap({
        invoiceId: payload.invoiceId,
        childId: payload.childId,
        amountAfterDiscount: payload.amountAfterDiscount,
        paidAt: payload.paidAt,
      }),
    };
  },

  'invoice.overdue': ({ payload }) => {
    const amount = formatAmount(payload.amountAfterDiscount);
    const days = String(payload.daysOverdue ?? '');
    return {
      titleI18n: {
        ru: 'Счёт просрочен',
        kk: 'Шот мерзімі өтті',
        en: 'Invoice overdue',
      },
      bodyI18n: {
        ru: `Счёт на сумму ${amount} ₸ просрочен на ${days} дн.`,
        kk: `${amount} ₸ шот ${days} күнге кешіктірілді.`,
        en: `Invoice ${amount} ₸ is ${days} days overdue.`,
      },
      data: stringMap({
        invoiceId: payload.invoiceId,
        childId: payload.childId,
        amountAfterDiscount: payload.amountAfterDiscount,
        dueDate: payload.dueDate,
        daysOverdue: payload.daysOverdue,
      }),
    };
  },

  'invoice.cancelled': ({ payload }) => ({
    titleI18n: {
      ru: 'Счёт отменён',
      kk: 'Шот жойылды',
      en: 'Invoice cancelled',
    },
    bodyI18n: {
      ru: 'Счёт был отменён.',
      kk: 'Шот жойылды.',
      en: 'The invoice was cancelled.',
    },
    data: stringMap({
      invoiceId: payload.invoiceId,
      childId: payload.childId,
      reason: payload.reason,
    }),
  }),

  'payment.completed': ({ payload }) => {
    const amount = formatAmount(payload.amount);
    const provider = asNonEmptyString(payload.provider) ?? '';
    return {
      titleI18n: {
        ru: 'Оплата прошла',
        kk: 'Төлем сәтті өтті',
        en: 'Payment completed',
      },
      bodyI18n: {
        ru: `Платёж ${amount} ₸ через ${provider} успешно обработан.`,
        kk: `Төлем ${amount} ₸ (${provider}) сәтті өңделді.`,
        en: `Payment ${amount} ₸ via ${provider} processed.`,
      },
      data: stringMap({
        paymentId: payload.paymentId,
        invoiceId: payload.invoiceId,
        childId: payload.childId,
        amount: payload.amount,
        provider: payload.provider,
        paidAt: payload.paidAt,
      }),
    };
  },

  'payment.failed': ({ payload }) => {
    const amount = formatAmount(payload.amount);
    return {
      titleI18n: {
        ru: 'Платёж не прошёл',
        kk: 'Төлем өтпеді',
        en: 'Payment failed',
      },
      bodyI18n: {
        ru: `Платёж ${amount} ₸ не прошёл.`,
        kk: `${amount} ₸ төлемі өтпеді.`,
        en: `Payment ${amount} ₸ failed.`,
      },
      data: stringMap({
        paymentId: payload.paymentId,
        invoiceId: payload.invoiceId,
        childId: payload.childId,
        amount: payload.amount,
        provider: payload.provider,
        failureReason: payload.failureReason,
      }),
    };
  },

  'payment.refunded': ({ payload }) => {
    const amount = formatAmount(payload.amount);
    return {
      titleI18n: {
        ru: 'Платёж возвращён',
        kk: 'Төлем қайтарылды',
        en: 'Payment refunded',
      },
      bodyI18n: {
        ru: `Платёж ${amount} ₸ возвращён.`,
        kk: `${amount} ₸ төлемі қайтарылды.`,
        en: `Payment ${amount} ₸ refunded.`,
      },
      data: stringMap({
        paymentId: payload.paymentId,
        invoiceId: payload.invoiceId,
        childId: payload.childId,
        amount: payload.amount,
        refundId: payload.refundId,
      }),
    };
  },

  'refund.processed': ({ payload }) => {
    const amount = formatAmount(payload.amount);
    return {
      titleI18n: {
        ru: 'Возврат обработан',
        kk: 'Қайтару өңделді',
        en: 'Refund processed',
      },
      bodyI18n: {
        ru: `Возврат ${amount} ₸ обработан.`,
        kk: `${amount} ₸ қайтарылым өңделді.`,
        en: `Refund ${amount} ₸ processed.`,
      },
      data: stringMap({
        refundId: payload.refundId,
        paymentId: payload.paymentId,
        invoiceId: payload.invoiceId,
        childId: payload.childId,
        amount: payload.amount,
      }),
    };
  },

  // ── B16 Custom Discount activation ────────────────────────────────────
  // Fired by `CustomDiscountService.activate` when the discount has
  // `notify_on_activation=true`. Recipient resolver fans out to the
  // children's approved-active guardian user_ids (parents only — nanny
  // role excluded by the resolver query). When the admin configured an
  // i18n title/body in the catalogue, the template uses those verbatim;
  // otherwise it falls back to a generic copy keyed by discountName.
  'discount.activated': ({ payload }) => {
    const tInline = payload.notificationTitle as Record<string, string> | null;
    const bInline = payload.notificationBody as Record<string, string> | null;
    const nameMap = (payload.discountName ?? {}) as Record<string, string>;
    const fallbackName =
      asNonEmptyString(nameMap.ru) ??
      asNonEmptyString(nameMap.kk) ??
      asNonEmptyString(nameMap.en) ??
      'скидка';
    const titleI18n = tInline ?? {
      ru: 'Новая скидка доступна',
      kk: 'Жаңа жеңілдік қолжетімді',
      en: 'New discount available',
    };
    const bodyI18n = bInline ?? {
      ru: `Скидка «${fallbackName}» теперь доступна для вашего ребёнка.`,
      kk: `«${fallbackName}» жеңілдігі сіздің балаңызға қолжетімді.`,
      en: `Discount "${fallbackName}" is now available for your child.`,
    };
    return {
      titleI18n,
      bodyI18n,
      data: stringMap({
        discountId: payload.discountId,
      }),
    };
  },

  // T11 H6 — admin-visible signal that the first invoice was skipped on
  // enrollment.card_created because no tariff_assignment was configured.
  'enrollment.first_invoice_skipped': ({ payload }) => ({
    titleI18n: {
      ru: 'Не выставлен первый счёт',
      kk: 'Алғашқы шот құрылмады',
      en: 'First invoice was not generated',
    },
    bodyI18n: {
      ru: 'Не настроен тариф для ребёнка — назначьте тариф и пересчитайте счёт.',
      kk: 'Балаға тариф тағайындалмаған — тарифті бекітіп, шотты қайта есептеңіз.',
      en: 'No tariff is configured for the child — assign a tariff and re-issue the invoice.',
    },
    data: stringMap({
      enrollmentId: payload.enrollmentId,
      childId: payload.childId,
      reason: payload.reason,
    }),
  }),
};

const RECIPIENT_RESOLVERS: Record<string, RecipientResolver> = {
  'attendance.checkin': resolveByChildGuardians,
  'attendance.checkout': resolveByChildGuardians,
  'daily_status.changed': resolveByChildGuardians,
  'timeline.entry_created': resolveByChildGuardians,
  'guardian.approved': resolveSelfFromField('guardianUserId'),
  'guardian.self_revoked': resolveSelfFromField('userId'),
  // ── B9 follow-up wiring ────────────────────────────────────────────────
  'guardian.pending_approval': resolveSelfFromField('primaryUserId'),
  'guardian.rejected': resolveSelfFromField('guardianUserId'),
  'guardian.revoked': resolveSelfFromField('guardianUserId'),
  'guardian.permissions_updated': resolveSelfFromField('guardianUserId'),
  'child.transferred': resolveByChildGuardians,
  // ── B11 Pickup OTP ─────────────────────────────────────────────────────
  // T7-5 MEDIUM#4: pickup recipients are re-validated against the
  // current guardian-link before delivery. Without this, a parent who
  // initiated a pickup_request and was subsequently revoked / unlinked
  // would still receive `pickup.otp_sent` and `pickup.validated`
  // notifications for the duration of the request's lifetime — leaking
  // child activity to an account that no longer has access.
  'pickup.otp_sent': resolvePickupOtpSentRecipients,
  'pickup.validated': resolvePickupValidatedRecipients,
  // ── B12 Parent-request events ──────────────────────────────────────────
  // For request.accepted / request.rejected the payload already names the
  // requester (parent who created the parent_request) and that's the only
  // recipient. We re-validate the guardian-link before delivery to avoid
  // leaking request decisions to a parent who has since been revoked
  // (mirrors the T7-5 MEDIUM#4 pattern from pickup.otp_sent).
  'request.accepted': resolveParentRequestRequesterRecipients,
  'request.rejected': resolveParentRequestRequesterRecipients,
  // request.cancelled goes to the assigned staff member (recipient_staff_id
  // resolved to user_id by the producer). When the request was directed at
  // `admin` (recipientStaffId=null), we don't fan out to the whole admin
  // pool from here — the admin's inbox view picks it up on the next list
  // refresh. (B22 may extend with kg-wide admin push if desired.)
  'request.cancelled': resolveParentRequestCancelledRecipients,
  // request.message_sent fans out based on authorRole: parent→staff or
  // staff→parent. Parent recipient is re-validated against the
  // guardian-link to close the same stale-recipient hole.
  'request.message_sent': resolveParentRequestMessageRecipients,
  // ── B13 Billing & Invoices ─────────────────────────────────────────────
  // invoice.* / payment.* / refund.* fan out to the child's approved-active
  // guardians; nannies are dropped by the policy gate (these keys are NOT in
  // NANNY_ALLOWED_EVENT_KEYS). The shared `resolveByChildGuardians` resolver
  // already classifies nanny rows into `nannyUserIds` so the policy filter
  // works correctly.
  'invoice.created': resolveByChildGuardians,
  'invoice.paid': resolveByChildGuardians,
  'invoice.overdue': resolveByChildGuardians,
  'invoice.cancelled': resolveByChildGuardians,
  'payment.completed': resolveByChildGuardians,
  'payment.failed': resolveByChildGuardians,
  'payment.refunded': resolveByChildGuardians,
  'refund.processed': resolveByChildGuardians,
  // T11 H6 — recipients are pre-resolved by the producer (kg admin
  // user_ids); the dispatcher reads the array verbatim from the payload.
  'enrollment.first_invoice_skipped': resolveRecipientUserIdsFromPayload,
  // ── B16 Custom Discount activation ─────────────────────────────────────
  // Producer pre-resolves the target child IDs via DiscountTargetResolver;
  // we fan out to the distinct set of approved-active guardian user_ids
  // across those children via a single multi-child query (parents only —
  // nanny role excluded at the SQL level).
  'discount.activated': resolveDiscountActivatedRecipients,
};

async function resolveByChildGuardians(
  event: OutboxEvent,
  deps: { guardianRepo: ChildGuardianRepository },
): Promise<ResolvedRecipients> {
  const childId = stringField(event.payload, 'childId');
  const guardians = await deps.guardianRepo.findByChildId(
    event.kindergartenId,
    childId,
  );
  const userIds: string[] = [];
  const nannyUserIds = new Set<string>();
  for (const g of guardians) {
    const state = g.toState();
    if (state.status !== 'approved' || state.revokedAt !== null) {
      continue;
    }
    if (!userIds.includes(state.userId)) {
      userIds.push(state.userId);
    }
    if (state.role === 'nanny') {
      nannyUserIds.add(state.userId);
    }
  }
  return { userIds, nannyUserIds, childId };
}

/**
 * Recipient resolver for `pickup.validated` — fans out to the child's
 * approved guardians AND includes the requester (the parent who started
 * the flow), but only if the requester is STILL an approved-active
 * guardian on the child at dispatch time (T7-5 MEDIUM#4 — closes the
 * stale-recipient leak). Deduplicates if the requester is already in
 * the guardian list. Marks nanny guardians so the nanny-policy gate
 * still applies.
 */
async function resolvePickupValidatedRecipients(
  event: OutboxEvent,
  deps: { guardianRepo: ChildGuardianRepository },
): Promise<ResolvedRecipients> {
  const guardiansResult = await resolveByChildGuardians(event, deps);
  const requesterId = stringField(event.payload, 'requesterUserId');
  // The base resolver already filters to approved + non-revoked
  // guardians. If the requester is in that list, dedup is enough.
  // Otherwise re-validate the requester independently — they may not
  // have been a guardian (e.g. staff-initiated request) OR may have
  // been revoked between enqueue and dispatch.
  if (guardiansResult.userIds.includes(requesterId)) {
    return guardiansResult;
  }
  const childId = stringField(event.payload, 'childId');
  const link = await deps.guardianRepo.findApprovedActiveByUserAndChild(
    event.kindergartenId,
    childId,
    requesterId,
  );
  if (link !== null) {
    guardiansResult.userIds.push(requesterId);
  }
  return guardiansResult;
}

/**
 * Recipient resolver for `pickup.otp_sent` — only the requester (parent)
 * receives this notification, and only if they are STILL an
 * approved-active guardian on the child at dispatch time. T7-5
 * MEDIUM#4: closes the leak where a parent revoked between enqueue and
 * dispatch would still get the OTP-sent SMS notification.
 */
async function resolvePickupOtpSentRecipients(
  event: OutboxEvent,
  deps: { guardianRepo: ChildGuardianRepository },
): Promise<ResolvedRecipients> {
  const requesterId = stringField(event.payload, 'requesterUserId');
  const childId = stringField(event.payload, 'childId');
  const link = await deps.guardianRepo.findApprovedActiveByUserAndChild(
    event.kindergartenId,
    childId,
    requesterId,
  );
  if (link === null) {
    return { userIds: [], nannyUserIds: new Set() };
  }
  return { userIds: [requesterId], nannyUserIds: new Set() };
}

function resolveSelfFromField(fieldName: string): RecipientResolver {
  return (event: OutboxEvent): Promise<ResolvedRecipients> => {
    const userId = stringField(event.payload, fieldName);
    return Promise.resolve({ userIds: [userId], nannyUserIds: new Set() });
  };
}

/**
 * Recipient resolver for events whose payload already names the target
 * user_ids array (T11 H6 `enrollment.first_invoice_skipped`). The producer
 * is expected to pre-resolve the list — typically kg admins from
 * `StaffMemberRepository` — so the dispatcher does not pull in
 * `StaffMemberRepository` (avoids notification ↔ staff module cycle).
 */
function resolveRecipientUserIdsFromPayload(
  event: OutboxEvent,
): Promise<ResolvedRecipients> {
  const raw = event.payload.recipientUserIds;
  const ids = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  return Promise.resolve({
    userIds: Array.from(new Set(ids)),
    nannyUserIds: new Set(),
  });
}

/**
 * Recipient resolver for `request.accepted` / `request.rejected` — only the
 * parent who created the parent_request receives the notification, and only
 * if they are STILL an approved-active guardian on the child at dispatch
 * time. Mirrors the pickup.otp_sent stale-recipient gate (T7-5 MEDIUM#4).
 *
 * T6 H1: when the requester is a nanny (admin override of `create_requests`
 * permission), classify them into `nannyUserIds` so `applyNannyPolicy` drops
 * the user before delivery — `request.*` is NOT in `NANNY_ALLOWED_EVENT_KEYS`.
 */
async function resolveParentRequestRequesterRecipients(
  event: OutboxEvent,
  deps: { guardianRepo: ChildGuardianRepository },
): Promise<ResolvedRecipients> {
  const requesterId = stringField(event.payload, 'requesterUserId');
  const childId = stringField(event.payload, 'childId');
  const link = await deps.guardianRepo.findApprovedActiveByUserAndChild(
    event.kindergartenId,
    childId,
    requesterId,
  );
  if (link === null) {
    return { userIds: [], nannyUserIds: new Set() };
  }
  const nannyUserIds = new Set<string>();
  if (link.toState().role === 'nanny') {
    nannyUserIds.add(requesterId);
  }
  return { userIds: [requesterId], nannyUserIds };
}

/**
 * Recipient resolver for `request.cancelled` — fans out to the staff member
 * the request was directed at (by user_id). When the request was directed at
 * `admin` (recipientStaffId=null) we deliver to nobody from the dispatcher;
 * admin views surface the row directly via list endpoints.
 */
function resolveParentRequestCancelledRecipients(
  event: OutboxEvent,
): Promise<ResolvedRecipients> {
  const recipientUserId = event.payload.recipientStaffUserId;
  if (typeof recipientUserId !== 'string' || recipientUserId.length === 0) {
    return Promise.resolve({ userIds: [], nannyUserIds: new Set() });
  }
  return Promise.resolve({
    userIds: [recipientUserId],
    nannyUserIds: new Set(),
  });
}

/**
 * Recipient resolver for `request.message_sent` — direction depends on
 * `authorRole`:
 *   - 'parent' author → notify the assigned staff (recipientStaffUserId)
 *   - 'staff'  author → notify the requester parent (re-validated)
 * Nannies are excluded by the nanny-policy gate; the parent re-validation
 * closes the stale-recipient hole.
 *
 * T6 H1: when the staff-reply requester is a nanny (admin override of
 * `create_requests`), tag them into `nannyUserIds` so `applyNannyPolicy`
 * drops the message — `request.*` is NOT in `NANNY_ALLOWED_EVENT_KEYS`.
 */
/**
 * Recipient resolver for `discount.activated` (B16). The producer pre-
 * resolves `targetChildIds` via `DiscountTargetResolver`; we fan out
 * to the distinct set of approved-active guardian user_ids across those
 * children. Nannies are excluded at the SQL layer
 * (`findApprovedUserIdsBySomeChildIds` filters `role <> 'nanny'`),
 * so the nanny-policy gate has no further work for this key.
 */
async function resolveDiscountActivatedRecipients(
  event: OutboxEvent,
  deps: { guardianRepo: ChildGuardianRepository },
): Promise<ResolvedRecipients> {
  const raw = event.payload.targetChildIds;
  const childIds = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  if (childIds.length === 0) {
    return { userIds: [], nannyUserIds: new Set() };
  }
  const userIds = await deps.guardianRepo.findApprovedUserIdsBySomeChildIds(
    event.kindergartenId,
    childIds,
  );
  return { userIds, nannyUserIds: new Set() };
}

async function resolveParentRequestMessageRecipients(
  event: OutboxEvent,
  deps: { guardianRepo: ChildGuardianRepository },
): Promise<ResolvedRecipients> {
  const authorRole = stringField(event.payload, 'authorRole');
  if (authorRole === 'parent') {
    const recipientUserId = event.payload.recipientStaffUserId;
    if (typeof recipientUserId !== 'string' || recipientUserId.length === 0) {
      return { userIds: [], nannyUserIds: new Set() };
    }
    return { userIds: [recipientUserId], nannyUserIds: new Set() };
  }
  // staff author → requester parent (with guardian re-validation)
  const requesterId = stringField(event.payload, 'requesterUserId');
  const childId = stringField(event.payload, 'childId');
  const link = await deps.guardianRepo.findApprovedActiveByUserAndChild(
    event.kindergartenId,
    childId,
    requesterId,
  );
  if (link === null) {
    return { userIds: [], nannyUserIds: new Set() };
  }
  const nannyUserIds = new Set<string>();
  if (link.toState().role === 'nanny') {
    nannyUserIds.add(requesterId);
  }
  return { userIds: [requesterId], nannyUserIds };
}

function stringMap(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Formats a numeric amount for the body templates. Tolerates `string`
 * payload values too — JSONB sometimes round-trips integers untouched but
 * treats large decimals as strings; we format whichever shape arrives.
 * Falls back to the empty string if the value is missing / unparseable so
 * a benign template render never fails the dispatch.
 */
function formatAmount(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toString();
  if (typeof v === 'string' && v.length > 0) return v;
  return '';
}

/**
 * NotificationDispatcher — pure transform from a single outbox event into
 * the side-effects:
 *   1. resolve recipients (`event.eventKey` × `payload` → user-ids)
 *   2. apply the per-user notification_preferences filter
 *   3. apply the nanny-allowlist policy
 *   4. INSERT history rows for users with `in_app_enabled=true`
 *   5. WS broadcast to `user:{id}` rooms (fire-and-forget)
 *   6. Push fan-out to each user's tokens (per-token try/catch with
 *      `classifyPushError` — permanent-token errors delete the token,
 *      transient errors abort the event so the worker re-tries).
 *
 * On `failed`, `dispatch()` THROWS `SavepointRollback` rather than
 * returning. The worker's per-event savepoint then rolls back, undoing the
 * history-row inserts — the next retry will not duplicate them. This keeps
 * the at-least-once outbox contract while staying exactly-once for history
 * rows.
 *
 * Recipient-resolution rules see `RECIPIENT_RESOLVERS` above; nanny policy
 * see `NANNY_ALLOWED_EVENT_KEYS` and `applyNannyPolicy`.
 *
 * The dispatcher does NOT call `outboxRepo.markDispatched` /
 * `markFailedWithRetry` itself — the worker (T6) owns that.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger('NotificationDispatcher');

  constructor(
    private readonly guardianRepo: ChildGuardianRepository,
    private readonly preferenceRepo: NotificationPreferenceRepository,
    private readonly pushTokenRepo: PushTokenRepository,
    private readonly notificationRepo: NotificationRepository,
    private readonly pushPort: PushNotificationPort,
    private readonly wsBroadcaster: WsBroadcaster,
    private readonly clock: ClockPort,
    private readonly childRepo: ChildRepository,
    private readonly groupRepo: GroupRepository,
    private readonly userRepo: UserRepository,
  ) {}

  async dispatch(event: OutboxEvent): Promise<DispatchResult> {
    try {
      const template = TEMPLATES[event.eventKey];
      const resolver = RECIPIENT_RESOLVERS[event.eventKey];
      if (!template || !resolver) {
        return this.fail(`unknown_event_key:${event.eventKey}`);
      }

      const recipients = await resolver(event, {
        guardianRepo: this.guardianRepo,
      });
      if (recipients.userIds.length === 0) {
        // Nothing to do — terminal success. Could legitimately happen if a
        // child's only guardian was revoked between enqueue and dispatch.
        return { status: 'dispatched' };
      }

      const filteredUserIds = this.applyNannyPolicy(
        event.eventKey,
        recipients.userIds,
        recipients.nannyUserIds,
      );
      if (filteredUserIds.length === 0) {
        return { status: 'dispatched' };
      }

      const preferences = await this.preferenceRepo.findByUserIdsAndEventKey(
        filteredUserIds,
        event.eventKey,
      );

      // Per-user effective flags (default both-enabled when no row).
      const effective = filteredUserIds.map((userId) => {
        const flags = preferences.get(userId) ?? {
          push_enabled: true,
          in_app_enabled: true,
        };
        return { userId, ...flags };
      });

      const inAppUsers = effective.filter((e) => e.in_app_enabled);
      const pushUsers = effective.filter((e) => e.push_enabled);

      // Resolve display-name enrichment once per dispatch — best effort.
      const enrichment = await this.enrichTemplateContext(event);
      const rendered = template({ payload: event.payload, enrichment });
      const now = this.clock.now();

      // 4) history rows (in_app_enabled only) — single bulk insert. Lives
      //    INSIDE the worker's savepoint via `tenantStorage`, so a later
      //    failed return rolls these back and the next retry re-inserts
      //    cleanly (no duplicate notifications on retry).
      if (inAppUsers.length > 0) {
        const rows: NotificationCreateInput[] = inAppUsers.map((u) => ({
          id: randomUUID(),
          kindergartenId: event.kindergartenId,
          userId: u.userId,
          eventKey: event.eventKey,
          titleI18n: rendered.titleI18n,
          bodyI18n: rendered.bodyI18n,
          data: rendered.data,
          createdAt: now,
        }));
        await this.notificationRepo.createMany(rows);

        // 5) WS — fire-and-forget. Errors logged, do not abort dispatch.
        for (const u of inAppUsers) {
          try {
            this.wsBroadcaster.broadcastToUser(u.userId, event.eventKey, {
              title_i18n: rendered.titleI18n,
              body_i18n: rendered.bodyI18n,
              data: rendered.data,
            });
          } catch (err) {
            this.logger.warn(
              `ws_broadcast_failed user=${u.userId} event=${event.eventKey}: ${(err as Error).message}`,
            );
          }
        }
      }

      // 6) Push fan-out — per-token classification.
      const transientFailures = await this.fanoutPush(
        event.eventKey,
        pushUsers.map((u) => u.userId),
        rendered,
      );
      if (transientFailures > 0) {
        return this.fail(`push_transient_failures=${transientFailures}`);
      }

      return { status: 'dispatched' };
    } catch (err) {
      // Unhandled exception (DB write, lookup, programmer bug). Surface as
      // `failed` so the worker's savepoint rolls back and the row retries.
      if (err instanceof SavepointRollback) {
        // Already a deliberate rollback — re-throw to the worker.
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `dispatch_failed event=${event.eventKey} id=${event.id ?? '<unknown>'}: ${reason}`,
      );
      return this.fail(reason);
    }
  }

  /**
   * Per-token push fan-out. Returns the number of transient (retriable)
   * failures; permanent-token errors delete the token and are treated as
   * success for the dispatch's purposes.
   */
  private async fanoutPush(
    eventKey: string,
    userIds: string[],
    rendered: NotificationTemplateResult,
  ): Promise<number> {
    if (userIds.length === 0) return 0;

    const tokens = await this.pushTokenRepo.findByUserIds(userIds);
    if (tokens.length === 0) return 0;

    const tokensByUser = new Map<
      string,
      { id: string; platform: 'ios' | 'android' | 'web'; token: string }[]
    >();
    for (const t of tokens) {
      const arr = tokensByUser.get(t.userId) ?? [];
      arr.push({ id: t.id, platform: t.platform, token: t.token });
      tokensByUser.set(t.userId, arr);
    }

    const pushTitle =
      rendered.titleI18n.ru ?? Object.values(rendered.titleI18n)[0] ?? '';
    const pushBody =
      rendered.bodyI18n.ru ?? Object.values(rendered.bodyI18n)[0] ?? '';

    let transientFailures = 0;
    for (const userId of userIds) {
      const userTokens = tokensByUser.get(userId);
      if (!userTokens || userTokens.length === 0) continue;
      for (const t of userTokens) {
        try {
          await this.pushPort.send(
            { userId, tokens: [t] },
            { title: pushTitle, body: pushBody, data: rendered.data },
          );
        } catch (err) {
          const cls = classifyPushError(err);
          if (cls === 'permanent_token') {
            // Best-effort cleanup — never let the cleanup itself break the
            // dispatch, otherwise a transient DB blip during cleanup would
            // be misclassified as a permanent push failure.
            this.logger.warn(
              `push_token_dead user=${userId} token=${t.id} event=${eventKey}: ${(err as Error).message}`,
            );
            try {
              await this.pushTokenRepo.deleteById(t.id);
            } catch (delErr) {
              this.logger.warn(
                `push_token_delete_failed token=${t.id}: ${(delErr as Error).message}`,
              );
            }
          } else {
            transientFailures += 1;
            this.logger.warn(
              `push_send_transient_failure user=${userId} token=${t.id} event=${eventKey}: ${(err as Error).message}`,
            );
          }
        }
      }
    }
    return transientFailures;
  }

  /**
   * Look up display names for the template once per dispatch. Best-effort:
   * any lookup that throws or returns null falls through to the static
   * fallback so a missing related row never converts a benign event into a
   * failed one.
   */
  private async enrichTemplateContext(
    event: OutboxEvent,
  ): Promise<TemplateEnrichment> {
    const out: TemplateEnrichment = { ...FALLBACK_ENRICHMENT };
    const childIdRaw = event.payload.childId;
    const childId = typeof childIdRaw === 'string' ? childIdRaw : null;

    // child name — needed by guardian.rejected/revoked/permissions_updated,
    // child.transferred, and as fallback for guardian.pending_approval.
    if (childId) {
      try {
        const child = await this.childRepo.findById(
          event.kindergartenId,
          childId,
        );
        if (child) out.childName = child.fullName;
      } catch (err) {
        this.logger.debug(
          `enrich_child_lookup_failed child=${childId}: ${(err as Error).message}`,
        );
      }
    }

    if (event.eventKey === 'child.transferred') {
      const toGroupIdRaw = event.payload.toGroupId;
      const toGroupId = typeof toGroupIdRaw === 'string' ? toGroupIdRaw : null;
      if (toGroupId) {
        try {
          const group = await this.groupRepo.findById(
            event.kindergartenId,
            toGroupId,
          );
          if (group) out.groupName = group.name;
        } catch (err) {
          this.logger.debug(
            `enrich_group_lookup_failed group=${toGroupId}: ${(err as Error).message}`,
          );
        }
      }
    }

    if (event.eventKey === 'guardian.pending_approval') {
      const requesterIdRaw = event.payload.requesterUserId;
      const requesterId =
        typeof requesterIdRaw === 'string' ? requesterIdRaw : null;
      if (requesterId) {
        try {
          const user = await this.userRepo.findById(requesterId);
          if (user && user.fullName.length > 0) {
            out.newGuardianName = user.fullName;
          }
        } catch (err) {
          this.logger.debug(
            `enrich_user_lookup_failed user=${requesterId}: ${(err as Error).message}`,
          );
        }
      }
    }

    return out;
  }

  private fail(reason: string): DispatchResult {
    return { status: 'failed', reason };
  }

  private applyNannyPolicy(
    eventKey: string,
    userIds: string[],
    nannyUserIds: Set<string>,
  ): string[] {
    if (NANNY_ALLOWED_EVENT_KEYS.has(eventKey)) {
      return userIds;
    }
    return userIds.filter((u) => !nannyUserIds.has(u));
  }
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`payload_missing_field:${key}`);
  }
  return v;
}

// Test/coverage helpers — kept exported so the dispatcher-coverage spec can
// assert that every CANONICAL_EVENT_KEY for which we have a producer call-
// site is wired with both a template and a recipient resolver.
export const EVENT_TEMPLATES = TEMPLATES;
export const EVENT_RECIPIENT_RESOLVERS = RECIPIENT_RESOLVERS;
