import { Injectable } from '@nestjs/common';
import { PaymentProvider } from './domain/entities/payment.entity';
import { BccNotConnectedError } from './domain/errors/bcc-not-connected.error';
import { PaymentProviderRegistry } from './infrastructure/payment-provider/payment-provider.registry';
import { BccMerchantAccountRepository } from './infrastructure/persistence/bcc-merchant-account.repository';
import { KaspiMerchantSessionRepository } from './infrastructure/persistence/kaspi-merchant-session.repository';

export interface AvailablePaymentMethod {
  provider: Exclude<PaymentProvider, 'cash'>;
  kind: 'redirect' | 'deeplink';
  displayName: string;
}

const METHOD_META: Partial<
  Record<
    PaymentProvider,
    { kind: 'redirect' | 'deeplink'; displayName: string }
  >
> = {
  mock: { kind: 'redirect', displayName: 'Тестовая оплата' },
  halyk_epay: { kind: 'redirect', displayName: 'Halyk ePay' },
  kaspi_pay: { kind: 'deeplink', displayName: 'Kaspi Pay' },
  tiptoppay: { kind: 'redirect', displayName: 'Оплата картой' },
  freedom_pay: { kind: 'redirect', displayName: 'Freedom Pay' },
  bcc: { kind: 'redirect', displayName: 'BCC Карта' },
};

@Injectable()
export class PaymentMethodAvailabilityService {
  constructor(
    private readonly registry: PaymentProviderRegistry,
    private readonly bccAccounts: BccMerchantAccountRepository,
    private readonly kaspiSessions: KaspiMerchantSessionRepository,
  ) {}

  async availableForKindergarten(
    kindergartenId: string,
  ): Promise<AvailablePaymentMethod[]> {
    const methods: AvailablePaymentMethod[] = [];
    for (const provider of this.registry.enabledProviders()) {
      if (!(await this.isTenantEnabled(kindergartenId, provider))) continue;
      const meta = METHOD_META[provider];
      if (!meta) continue;
      methods.push({
        provider: provider as Exclude<PaymentProvider, 'cash'>,
        kind: meta.kind,
        displayName: meta.displayName,
      });
    }
    return methods;
  }

  async assertBccActive(kindergartenId: string): Promise<void> {
    const account = await this.bccAccounts.findByKindergartenId(kindergartenId);
    if (!account?.isActive()) {
      throw new BccNotConnectedError();
    }
  }

  private async isTenantEnabled(
    kindergartenId: string,
    provider: PaymentProvider,
  ): Promise<boolean> {
    if (provider === 'bcc') {
      const account =
        await this.bccAccounts.findByKindergartenId(kindergartenId);
      return account?.isActive() === true;
    }
    if (provider === 'kaspi_pay') {
      const session =
        await this.kaspiSessions.findByKindergartenId(kindergartenId);
      return session?.isActive() === true;
    }
    return true;
  }
}
