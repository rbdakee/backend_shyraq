import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PasswordHasherPort } from '@/modules/auth/password-hasher.port';
import { KindergartenRepository } from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { KindergartenNotFoundError } from '@/modules/kindergarten/domain/errors/kindergarten-not-found.error';
import { AllConfigType } from '@/config/config.type';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import {
  BccConnectionResult,
  BccEnvironment,
  BccMerchantAccount,
  BccMerchantAccountState,
} from './domain/entities/bcc-merchant-account.entity';
import {
  BccConnectionCheckFailedError,
  BccGatewayUnavailableError,
} from './domain/errors/bcc-connection-check.error';
import { BccMacComponentsInvalidError } from './domain/errors/bcc-mac-components-invalid.error';
import { BccMerchantAccountActiveError } from './domain/errors/bcc-merchant-account-active.error';
import { BccMerchantAccountNotFoundError } from './domain/errors/bcc-merchant-account-not-found.error';
import {
  buildBccConnectivityCheckRequest,
  combineBccMacKeyComponents,
} from './infrastructure/payment-provider/bcc/bcc-crypto';
import { BccHttpClient } from './infrastructure/payment-provider/bcc/bcc-http.client';
import { BccMerchantAccountRepository } from './infrastructure/persistence/bcc-merchant-account.repository';

export interface UpsertBccAccountInput {
  merchantId: string;
  terminalId: string;
  merchantName: string | null;
  environment: BccEnvironment;
  macKeyComponent1: string;
  macKeyComponent2: string;
}

export interface BccAccountView {
  connected: boolean;
  status: 'draft' | 'active' | 'disabled';
  merchantId: string;
  terminalId: string;
  merchantName: string | null;
  environment: BccEnvironment;
  lastConnectionCheckedAt: Date | null;
  lastConnectionResult: BccConnectionResult | null;
}

export interface BccOneTimeCallbackCredentials {
  notifyUrl: string;
  notifyUsername: string;
  notifyPassword: string;
}

export interface BccAccountProvisioningResult {
  account: BccAccountView;
  callbackCredentials?: BccOneTimeCallbackCredentials;
}

export interface BccConnectionCheckResult {
  connected: boolean;
  status: 'draft' | 'active' | 'disabled';
  checkedAt: Date;
  result: BccConnectionResult;
}

interface GeneratedCallbackCredentials {
  token: string;
  tokenHash: string;
  tokenEnc: string;
  username: string;
  password: string;
  passwordHash: string;
}

@Injectable()
export class BccMerchantOnboardingService {
  constructor(
    private readonly accounts: BccMerchantAccountRepository,
    private readonly kindergartens: KindergartenRepository,
    @Inject(CryptoCipherPort)
    private readonly cipher: CryptoCipherPort,
    @Inject(PasswordHasherPort)
    private readonly passwords: PasswordHasherPort,
    private readonly http: BccHttpClient,
    @Inject(ClockPort)
    private readonly clock: ClockPort,
    private readonly config: ConfigService<AllConfigType>,
  ) {}

  async upsert(
    kindergartenId: string,
    input: UpsertBccAccountInput,
    actorId: string,
  ): Promise<BccAccountProvisioningResult> {
    const kindergarten = await this.kindergartens.findById(kindergartenId);
    if (!kindergarten) throw new KindergartenNotFoundError(kindergartenId);

    const now = this.clock.now();
    const macKeyEnc = this.encryptMacComponents(
      input.macKeyComponent1,
      input.macKeyComponent2,
    );
    const existing = await this.accounts.findByKindergartenId(kindergartenId);

    if (existing) {
      if (existing.isActive()) throw new BccMerchantAccountActiveError();
      existing.updateDraftConfiguration(
        {
          merchantId: input.merchantId.trim(),
          terminalId: input.terminalId.trim(),
          merchantName: normalizeOptional(input.merchantName),
          macKeyEnc,
          environment: input.environment,
        },
        now,
        actorId,
      );
      return {
        account: toView(await this.accounts.save(existing)),
      };
    }

    const callback = await this.generateCallbackCredentials();
    const state: BccMerchantAccountState = {
      id: randomUUID(),
      kindergartenId,
      merchantId: input.merchantId.trim(),
      terminalId: input.terminalId.trim(),
      merchantName: normalizeOptional(input.merchantName),
      macKeyEnc,
      environment: input.environment,
      status: 'draft',
      callbackTokenHash: callback.tokenHash,
      callbackTokenEnc: callback.tokenEnc,
      notifyUsername: callback.username,
      notifyPasswordHash: callback.passwordHash,
      lastConnectionCheckedAt: null,
      lastConnectionResult: null,
      disabledAt: null,
      updatedBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await this.accounts.save(BccMerchantAccount.fromState(state));
    return {
      account: toView(saved),
      callbackCredentials: {
        notifyUrl: this.notifyUrl(callback.token),
        notifyUsername: callback.username,
        notifyPassword: callback.password,
      },
    };
  }

  async get(kindergartenId: string): Promise<BccAccountView> {
    return toView(await this.requireAccount(kindergartenId));
  }

  async checkConnection(
    kindergartenId: string,
    actorId: string,
  ): Promise<BccConnectionCheckResult> {
    const account = await this.requireAccount(kindergartenId);
    const callbackToken = this.cipher.decryptString(account.callbackTokenEnc);
    const request = buildBccConnectivityCheckRequest({
      terminal: account.terminalId,
      backref: this.backrefUrl(),
      lang: 'ru',
      notifyUrl: this.notifyUrl(callbackToken),
    });

    let response;
    try {
      response = await this.http.execute(account.environment, request);
    } catch {
      const checkedAt = this.clock.now();
      const result: BccConnectionResult = {
        success: false,
        action: null,
        rc: null,
        rcText: 'transport_error',
      };
      account.recordConnectionCheck(result, checkedAt, actorId);
      await this.accounts.saveBypassRls(account);
      throw new BccGatewayUnavailableError();
    }

    const checkedAt = this.clock.now();
    const diagnostics = response.diagnostics;
    const success =
      response.httpOk &&
      (diagnostics.action === '0' || diagnostics.rc === '00');
    const result: BccConnectionResult = {
      success,
      action: sanitizeCode(diagnostics.action),
      rc: sanitizeCode(diagnostics.rc),
      rcText: sanitizeText(diagnostics.rcText),
    };
    account.recordConnectionCheck(result, checkedAt, actorId);

    if (success) {
      if (!account.isActive()) account.activate(checkedAt, actorId);
      const saved = await this.accounts.save(account);
      return {
        connected: saved.isActive(),
        status: saved.status,
        checkedAt,
        result,
      };
    }

    await this.accounts.saveBypassRls(account);
    throw new BccConnectionCheckFailedError();
  }

  async disable(
    kindergartenId: string,
    actorId: string,
  ): Promise<{ status: 'disabled' }> {
    const account = await this.requireAccount(kindergartenId);
    account.disable(this.clock.now(), actorId);
    await this.accounts.save(account);
    return { status: 'disabled' };
  }

  async rotateMac(
    kindergartenId: string,
    component1: string,
    component2: string,
    actorId: string,
  ): Promise<BccAccountView> {
    const account = await this.requireAccount(kindergartenId);
    const macKeyEnc = this.encryptMacComponents(component1, component2);
    account.rotateMacKey(macKeyEnc, this.clock.now(), actorId);
    return toView(await this.accounts.save(account));
  }

  async rotateCallbackCredentials(
    kindergartenId: string,
    actorId: string,
  ): Promise<BccOneTimeCallbackCredentials> {
    const account = await this.requireAccount(kindergartenId);
    const generated = await this.generateCallbackCredentials();
    account.rotateCallbackCredentials(
      {
        callbackTokenHash: generated.tokenHash,
        callbackTokenEnc: generated.tokenEnc,
        notifyUsername: generated.username,
        notifyPasswordHash: generated.passwordHash,
      },
      this.clock.now(),
      actorId,
    );
    await this.accounts.save(account);
    return {
      notifyUrl: this.notifyUrl(generated.token),
      notifyUsername: generated.username,
      notifyPassword: generated.password,
    };
  }

  private async requireAccount(
    kindergartenId: string,
  ): Promise<BccMerchantAccount> {
    const account = await this.accounts.findByKindergartenId(kindergartenId);
    if (!account) throw new BccMerchantAccountNotFoundError(kindergartenId);
    return account;
  }

  private encryptMacComponents(component1: string, component2: string): string {
    let combined: Buffer;
    try {
      combined = combineBccMacKeyComponents(component1, component2);
    } catch {
      throw new BccMacComponentsInvalidError();
    }
    try {
      return this.cipher.encryptString(combined.toString('hex').toUpperCase());
    } finally {
      combined.fill(0);
    }
  }

  private async generateCallbackCredentials(): Promise<GeneratedCallbackCredentials> {
    const token = randomBytes(32).toString('base64url');
    const username = `bcc_${randomBytes(12).toString('hex')}`;
    const password = randomBytes(32).toString('base64url');
    return {
      token,
      tokenHash: sha256(token),
      tokenEnc: this.cipher.encryptString(token),
      username,
      password,
      passwordHash: await this.passwords.hash(password),
    };
  }

  private notifyUrl(token: string): string {
    return this.backendUrl(
      `webhooks/payments/bcc/${encodeURIComponent(token)}`,
    );
  }

  private backrefUrl(): string {
    return this.backendUrl('payments/bcc/return');
  }

  private backendUrl(route: string): string {
    const origin = this.config.getOrThrow('app.backendDomain', {
      infer: true,
    });
    const prefix = this.config.getOrThrow('app.apiPrefix', { infer: true });
    const base = origin.endsWith('/') ? origin : `${origin}/`;
    return new URL(
      `${prefix.replace(/^\/|\/$/g, '')}/v1/${route}`,
      base,
    ).toString();
  }
}

function toView(account: BccMerchantAccount): BccAccountView {
  return {
    connected: account.isActive(),
    status: account.status,
    merchantId: account.merchantId,
    terminalId: account.terminalId,
    merchantName: account.merchantName,
    environment: account.environment,
    lastConnectionCheckedAt: account.lastConnectionCheckedAt,
    lastConnectionResult: account.lastConnectionResult,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeOptional(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function sanitizeCode(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32) || null;
}

function sanitizeText(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 160);
}
