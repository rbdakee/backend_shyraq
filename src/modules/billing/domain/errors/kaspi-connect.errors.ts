import {
  ConflictError,
  DomainError,
  NotFoundError,
} from '@/shared-kernel/domain/errors';

/**
 * Kaspi SMS-onboarding domain errors (B24 / K5).
 *
 * Codes are the locked §2.25 catalogue. HTTP mapping (in `DomainErrorFilter`):
 *   - kaspi_already_connected      → 409  (extends ConflictError)
 *   - kaspi_not_connected          → 404  (extends NotFoundError)
 *   - kaspi_unknown_process        → 400  (explicit filter branch)
 *   - kaspi_otp_invalid            → 401  (explicit filter branch)
 *   - kaspi_app_version_outdated   → 502  (explicit filter branch — mirrors
 *                                          PaymentProviderError → BAD_GATEWAY)
 *   - kaspi_finish_failed          → 502  (explicit filter branch)
 *
 * The 400/401/502 classes extend the abstract `DomainError` base directly
 * (there is no 400/401/502 base in shared-kernel), so the filter matches them
 * by their concrete type — exactly how `PaymentProviderError` achieves its 502.
 */

/** 409 — an active session already exists; admin must disconnect first. */
export class KaspiAlreadyConnectedError extends ConflictError {
  constructor() {
    super('kaspi_already_connected');
  }
}

/** 404 — no session row for this kindergarten. */
export class KaspiNotConnectedError extends NotFoundError {
  override readonly code = 'kaspi_not_connected';
  constructor() {
    super('kaspi_merchant_session', 'current');
  }
}

/** 400 — the process_id is unknown or its Redis in-flight blob expired. */
export class KaspiUnknownProcessError extends DomainError {
  constructor() {
    super('kaspi_unknown_process');
  }
}

/** 401 — the SMS OTP was rejected by Kaspi. */
export class KaspiOtpInvalidError extends DomainError {
  constructor() {
    super('kaspi_otp_invalid');
  }
}

/**
 * 502 — Kaspi's version gate blocked the current `app_build`
 * (`OldVersionToUpdate`). The super-admin must raise `app_build` in
 * `kaspi_global_config`.
 */
export class KaspiAppVersionOutdatedError extends DomainError {
  constructor() {
    super('kaspi_app_version_outdated');
  }
}

/**
 * 409 — Kaspi answered the `EnterPhoneNumber` step with the login+password
 * screen (`view.code=KPEnterLoginPassword`, `meta.sn=ViewEnterLoginPassword`)
 * instead of the SMS OTP step. No SMS is sent, and the 3-step SMS onboarding
 * cannot continue for this number.
 *
 * Observed live 03.08.2026 on entrance-pay.kaspi.kz: reproducible for the same
 * phone across app_build 1100/1120/9999 and `noPass=0/1`, `sf=registration/
 * login` — i.e. it is a property of the Kaspi ACCOUNT, not of our build or
 * flow parameters. Previously this fell into the `send_phone_failed` catch-all
 * and surfaced to the admin as an opaque 502.
 */
export class KaspiPasswordLoginRequiredError extends ConflictError {
  constructor() {
    super('kaspi_password_login_required');
  }
}

/**
 * 409 — device registration succeeded (entrance `finish` returned a tokenSN)
 * but `org-context-otp` answered `StatusCode=0` with an empty `Data.Current`:
 * the Kaspi account carries no merchant profile (no ProfileId/OrganizationId),
 * so there is nothing to sign payments with.
 *
 * Distinct from `kaspi_finish_failed('finish_org_context_rejected')`, which is
 * the `StatusCode != 0` case — Kaspi REJECTING the request (bad build, bad
 * signature, expired token) rather than reporting an account without an org.
 * The two were indistinguishable before: both logged only `hasOrgId=false
 * hasOrgName=false` and returned 502.
 */
export class KaspiNoBusinessProfileError extends ConflictError {
  constructor() {
    super('kaspi_no_business_profile');
  }
}

/**
 * 409 — Kaspi invalidated our registered device because the account signed in
 * from somewhere else (mtoken `StatusCode=-101001`, `Description='Token not
 * valid'`, `Message='Был выполнен вход с другого устройства…'`).
 *
 * Kaspi Pay permits ONE active device per account, so the merchant simply
 * opening their own Kaspi Pay app displaces us. This is the single root cause
 * behind both observed onboarding failures (verified live 2026-08-03, and
 * identical on app_build 1076/1100/9999 — the build is not a factor):
 *   - every mtoken call (`org-context-otp`, `sign-in-lite`) is rejected, so an
 *     existing session dies;
 *   - re-onboarding by SMS is refused too — `EnterPhoneNumber` routes to
 *     `KPEnterLoginPassword`, which is why [KaspiPasswordLoginRequiredError]
 *     fires on what looks like an unrelated step.
 *
 * Recovery requires a login+password re-registration, not an SMS retry.
 */
export class KaspiSessionTakenOverError extends ConflictError {
  constructor() {
    super('kaspi_session_taken_over');
  }
}

/**
 * 401 — Kaspi accepted the password field but did not advance to the OTP step:
 * a wrong password, or an account lockout. Mirrors `kaspi_otp_invalid`, which
 * is the same class of failure one step later.
 *
 * The password itself is never echoed, logged or stored — only Kaspi's own
 * business code reaches the server log.
 */
export class KaspiPasswordInvalidError extends DomainError {
  constructor() {
    super('kaspi_password_invalid');
  }
}

/**
 * 502 — the entrance `finish` (or downstream org-context) call failed. The raw
 * Kaspi reason is kept server-side only (`internalReason`), NEVER in the body.
 */
export class KaspiFinishFailedError extends DomainError {
  /** Server-side log only — never exposed to clients. */
  public readonly internalReason: string;
  constructor(internalReason: string) {
    super('kaspi_finish_failed');
    this.internalReason = internalReason;
  }
}

/**
 * 400 — the supplied cashier phone could not be normalized to a 10-digit KZ
 * national number (the form Kaspi's `EnterPhoneNumber` step expects, e.g.
 * `7772270088`). Sending the 11-digit country-code form (`77772270088`) makes
 * Kaspi reject it with `UserPhoneNumberDoesNotBelongToAnyOperator`, so the
 * backend normalizes before the call — this guards a value that still can't be
 * reduced to 10 digits.
 */
export class KaspiInvalidPhoneError extends DomainError {
  constructor() {
    super('kaspi_invalid_phone');
  }
}

/**
 * 400 — `createPayment` was invoked for `provider=kaspi_pay` without a payer
 * phone number. Kaspi `remote/create` requires `PhoneNumber`; the DTO-level
 * guard lands in K7, but the adapter guards too (defence-in-depth).
 *
 * NOTE: when thrown from inside `KaspiPaymentProvider.createPayment`, this
 * surfaces to the client as a 502 `payment_provider_error` — `PaymentService.
 * initiate` catches ANY throw from the provider, marks the payment row failed,
 * and wraps it in `PaymentProviderError`. The clean 400 path is the K7 DTO
 * guard which rejects BEFORE the service reaches the provider. The dedicated
 * 400 mapping here exists so the error is correctly typed/surfaced when thrown
 * from a context (the K7 controller / future direct callers) that does NOT pass
 * through the PaymentService catch-all.
 */
export class KaspiPhoneRequiredError extends DomainError {
  constructor() {
    super('kaspi_phone_required');
  }
}

/**
 * 501 — `verifyWebhook` is unsupported for `provider=kaspi_pay`. Kaspi has no
 * inbound payment callback; settlement is driven by the K8 BullMQ poller
 * (`kaspi-payment-status`, `remote/details` by `QrOperationId`). Documented in
 * `docs/endpoints.md` §4.5 / §4.7 (error catalog: 501 `kaspi_webhook_unsupported`).
 */
export class KaspiWebhookUnsupportedError extends DomainError {
  constructor() {
    super('kaspi_webhook_unsupported');
  }
}
