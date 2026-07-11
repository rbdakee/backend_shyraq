import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';
import { PasswordHasherPort } from '@/modules/auth/password-hasher.port';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import { BccBillingDetailsRequiredError } from '../../../domain/errors/bcc-billing-details-required.error';
import { BccCheckoutExpiredError } from '../../../domain/errors/bcc-checkout-expired.error';
import { BccNotConnectedError } from '../../../domain/errors/bcc-not-connected.error';
import {
  BccCallbackInvalidError,
  BccCallbackUnauthorizedError,
} from '../../../domain/errors/bcc-callback.error';
import { BccCheckoutStorePort } from '../../checkout/bcc-checkout-store.port';
import { BccMerchantAccountRepository } from '../../persistence/bcc-merchant-account.repository';
import {
  CreatePaymentInput,
  CreatePaymentResult,
  ExistingPaymentContinuation,
  ExistingPaymentContinuationInput,
  PaymentProviderPort,
  RefundInput,
  RefundResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from '../payment-provider.port';
import {
  formatBccTimestamp,
  generateBccMerchRnId,
  generateBccNonce,
  generateBccOrder,
} from './bcc-crypto';
import {
  bccGatewayUrl,
  buildBccPurchaseRequest,
  buildBccRefundRequest,
  buildBccStatusRequest,
} from './bcc-protocol';
import { buildBccBackendUrl } from './bcc-url';
import { BccHttpClient, BccGatewayResponse } from './bcc-http.client';
import {
  constantTimeTextEqual,
  isBccSuccess,
  isBccTerminalFailure,
  parseBccBasicAuthorization,
  parseBccCallbackBody,
} from './bcc-callback';

/**
 * BCC purchase adapter. It prepares the signed CARD step #1 and stores it in
 * an encrypted, one-time Redis checkout session. PAN/expiry/CVC are never
 * accepted here; the browser submits them only to the hosted BCC page.
 */
@Injectable()
export class BccPaymentProvider extends PaymentProviderPort {
  constructor(
    private readonly accounts: BccMerchantAccountRepository,
    private readonly checkoutStore: BccCheckoutStorePort,
    @Inject(CryptoCipherPort)
    private readonly cipher: CryptoCipherPort,
    @Inject(ClockPort)
    private readonly clock: ClockPort,
    private readonly config: ConfigService<AllConfigType>,
    @Inject(PasswordHasherPort)
    private readonly passwords: PasswordHasherPort,
    private readonly http: BccHttpClient,
  ) {
    super();
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!input.paymentId) throw new Error('bcc_payment_id_required');
    if (!input.billingPhone || !input.billingAddress) {
      throw new BccBillingDetailsRequiredError();
    }
    const account = await this.accounts.findByKindergartenId(
      input.kindergartenId,
    );
    if (!account?.isActive()) throw new BccNotConnectedError();

    const order = generateBccOrder(this.clock.now());
    const callbackToken = this.cipher.decryptString(account.callbackTokenEnc);
    const macKeyBuffer = this.cipher.decrypt(account.macKeyEnc);
    let formFields;
    try {
      formFields = buildBccPurchaseRequest({
        amount: input.amountKzt,
        order,
        merchRnId: generateBccMerchRnId(),
        description: `Shyraq invoice ${input.invoiceId}`,
        merchantId: account.merchantId,
        merchantName: account.merchantName?.trim() || 'SHYRAQ',
        terminalId: account.terminalId,
        timestamp: formatBccTimestamp(this.clock.now()),
        nonce: generateBccNonce(),
        macKeyHex: macKeyBuffer.toString('utf8'),
        backref: buildBccBackendUrl(this.config, 'payments/bcc/return'),
        language: 'ru',
        notifyUrl: buildBccBackendUrl(
          this.config,
          `webhooks/payments/bcc/${encodeURIComponent(callbackToken)}`,
        ),
        // Dynamic browser values are replaced by the checkout bridge. They do
        // not participate in BCC's TRTYPE=1 MAC source.
        clientIp: '0.0.0.0',
        mInfo: Buffer.from('{}').toString('base64'),
      });
    } finally {
      macKeyBuffer.fill(0);
    }
    delete formFields.CLIENT_IP;
    delete formFields.M_INFO;

    const handle = await this.checkoutStore.createOrReuse({
      paymentId: input.paymentId,
      kindergartenId: input.kindergartenId,
      order,
      gatewayUrl: bccGatewayUrl(account.environment),
      formFields,
      billingPhone: input.billingPhone,
      billingAddress: input.billingAddress,
    });
    const redirectUrl = buildBccBackendUrl(
      this.config,
      `payments/bcc/checkout/${encodeURIComponent(handle.token)}`,
    );
    return {
      providerPaymentId: order,
      redirectUrl,
      providerPayload: {
        order,
        merchant_id: account.merchantId,
        terminal_id: account.terminalId,
        environment: account.environment,
        transaction_type: '1',
      },
      status: 'initiated',
    };
  }

  async getExistingPaymentContinuation(
    input: ExistingPaymentContinuationInput,
  ): Promise<ExistingPaymentContinuation | null> {
    const token = await this.checkoutStore.findTokenByPayment(
      input.kindergartenId,
      input.paymentId,
    );
    if (!token) throw new BccCheckoutExpiredError();
    return {
      redirectUrl: buildBccBackendUrl(
        this.config,
        `payments/bcc/checkout/${encodeURIComponent(token)}`,
      ),
    };
  }

  async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    const token = input.callbackToken;
    if (!token || token.length > 256) {
      throw new BccCallbackUnauthorizedError();
    }
    const account = await this.accounts.findByCallbackTokenHashBypassRls(
      createHash('sha256').update(token, 'utf8').digest('hex'),
    );
    const basic = parseBccBasicAuthorization(input.headers.authorization);
    if (!account || !basic) {
      throw new BccCallbackUnauthorizedError();
    }
    const usernameValid = constantTimeTextEqual(
      basic.username,
      account.notifyUsername,
    );
    const passwordValid = await this.passwords.compare(
      basic.password,
      account.notifyPasswordHash,
    );
    if (!usernameValid || !passwordValid) {
      throw new BccCallbackUnauthorizedError();
    }

    let fields;
    try {
      fields = parseBccCallbackBody(input.body);
    } catch {
      throw new BccCallbackInvalidError();
    }
    if (
      !constantTimeTextEqual(fields.terminal, account.terminalId) ||
      !constantTimeTextEqual(fields.merchant, account.merchantId)
    ) {
      throw new BccCallbackInvalidError();
    }

    const success = isBccSuccess(fields.action, fields.rc);
    const terminalFailure = isBccTerminalFailure(fields.action, fields.rc);
    return {
      providerPaymentId: fields.order,
      status: success ? 'completed' : terminalFailure ? 'failed' : 'processing',
      ...(terminalFailure ? { failureReason: `bcc_rc_${fields.rc}` } : {}),
      raw: {
        action: fields.action,
        rc: fields.rc,
        rc_text: fields.rcText,
        rrn: fields.rrn,
        int_ref: fields.intRef,
        source: 'bcc_callback',
      },
      callbackContext: {
        kindergartenId: account.kindergartenId,
        amountKzt: fields.amountKzt,
        currency: fields.currency,
      },
    };
  }

  async getPaymentStatus(input: {
    kindergartenId: string;
    order: string;
  }): Promise<BccGatewayResponse> {
    const account = await this.accounts.findByKindergartenIdBypassRls(
      input.kindergartenId,
    );
    if (!account) throw new BccNotConnectedError();
    const callbackToken = this.cipher.decryptString(account.callbackTokenEnc);
    const macKeyBuffer = this.cipher.decrypt(account.macKeyEnc);
    let request;
    try {
      request = buildBccStatusRequest({
        order: input.order,
        terminalId: account.terminalId,
        timestamp: formatBccTimestamp(this.clock.now()),
        nonce: generateBccNonce(),
        macKeyHex: macKeyBuffer.toString('utf8'),
        notifyUrl: buildBccBackendUrl(
          this.config,
          `webhooks/payments/bcc/${encodeURIComponent(callbackToken)}`,
        ),
        transactionType: '1',
      });
    } finally {
      macKeyBuffer.fill(0);
    }
    return this.http.execute(account.environment, request);
  }

  /**
   * Gate G — refund via `TRTYPE=14`. Full and partial are the same request:
   * `ORG_AMOUNT` always carries the original purchase total, `AMOUNT` the
   * (possibly partial) refund. The remaining-refundable guard lives in
   * `RefundService.create` (amount ≤ payment.amount); this method signs and
   * sends the server-to-server operation.
   *
   * `RRN`/`INT_REF` come from the original settlement (callback or `TRTYPE=90`
   * reconciliation) that `RefundService` forwards on `originalProviderData`.
   * Success requires `ACTION=0` and `RC=00`; any other outcome throws so
   * `RefundService` leaves the local refund `approved` for a safe retry (no
   * payment/invoice/ledger flip). BCC's own duplicate-`TRTYPE=14` protection
   * and our per-refund advisory lock keep retries from double-refunding.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    const rrn = readPayloadString(input.originalProviderData, 'rrn');
    const intRef = readPayloadString(input.originalProviderData, 'int_ref');
    if (!rrn || !intRef || input.originalAmountKzt === undefined) {
      // A settled BCC purchase always persisted RRN/INT_REF. Their absence
      // means this payment never cleared through BCC — refuse rather than
      // sign an unusable TRTYPE=14. RefundService maps this to a 502.
      throw new Error('bcc_refund_context_missing');
    }

    const account = await this.accounts.findByKindergartenId(
      input.kindergartenId,
    );
    if (!account) throw new BccNotConnectedError();

    const callbackToken = this.cipher.decryptString(account.callbackTokenEnc);
    const macKeyBuffer = this.cipher.decrypt(account.macKeyEnc);
    let request;
    try {
      request = buildBccRefundRequest({
        order: input.providerPaymentId,
        originalAmount: input.originalAmountKzt,
        amount: input.amountKzt,
        rrn,
        intRef,
        terminalId: account.terminalId,
        timestamp: formatBccTimestamp(this.clock.now()),
        nonce: generateBccNonce(),
        macKeyHex: macKeyBuffer.toString('utf8'),
        notifyUrl: buildBccBackendUrl(
          this.config,
          `webhooks/payments/bcc/${encodeURIComponent(callbackToken)}`,
        ),
      });
    } finally {
      macKeyBuffer.fill(0);
    }

    const response = await this.http.execute(account.environment, request);
    const {
      action,
      rc,
      rrn: refundRrn,
      intRef: refundIntRef,
    } = response.diagnostics;
    if (!isBccSuccess(action, rc)) {
      throw new Error(`bcc_refund_declined:RC=${rc ?? '-'}`);
    }

    // Prefer a BCC-supplied refund identifier; fall back to a deterministic id
    // bound to the original ORDER so repeated processing stays traceable.
    const providerRefundId =
      refundRrn ?? refundIntRef ?? `bcc_refund_${input.providerPaymentId}`;
    return { providerRefundId, status: 'processed' };
  }
}

function readPayloadString(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}
