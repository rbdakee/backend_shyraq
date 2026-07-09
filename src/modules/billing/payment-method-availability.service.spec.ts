import { BccMerchantAccount } from './domain/entities/bcc-merchant-account.entity';
import { PaymentProviderPort } from './infrastructure/payment-provider/payment-provider.port';
import { PaymentProviderRegistry } from './infrastructure/payment-provider/payment-provider.registry';
import { BccMerchantAccountRepository } from './infrastructure/persistence/bcc-merchant-account.repository';
import { KaspiMerchantSessionRepository } from './infrastructure/persistence/kaspi-merchant-session.repository';
import { PaymentMethodAvailabilityService } from './payment-method-availability.service';

const KG_ID = '00000000-0000-4000-8000-000000000001';

function adapter(): PaymentProviderPort {
  return {} as PaymentProviderPort;
}

function bcc(status: 'draft' | 'active' | 'disabled'): BccMerchantAccount {
  const now = new Date('2026-07-06T04:30:00.000Z');
  return BccMerchantAccount.fromState({
    id: '00000000-0000-4000-8000-000000000010',
    kindergartenId: KG_ID,
    merchantId: 'merchant',
    terminalId: '88888881',
    merchantName: null,
    macKeyEnc: 'ciphertext',
    environment: 'test',
    status,
    callbackTokenHash: 'a'.repeat(64),
    callbackTokenEnc: 'ciphertext',
    notifyUsername: 'notify',
    notifyPasswordHash: 'hash',
    lastConnectionCheckedAt: null,
    lastConnectionResult: null,
    disabledAt: status === 'disabled' ? now : null,
    updatedBy: '00000000-0000-4000-8000-000000000002',
    createdAt: now,
    updatedAt: now,
  });
}

describe('PaymentMethodAvailabilityService', () => {
  it('returns BCC only for an active tenant account and keeps Kaspi independent', async () => {
    let bccAccount = bcc('draft');
    let kaspiActive = true;
    const registry = new PaymentProviderRegistry(
      [
        { provider: 'bcc', adapter: adapter() },
        { provider: 'kaspi_pay', adapter: adapter() },
      ],
      ['bcc', 'kaspi_pay'],
    );
    const service = new PaymentMethodAvailabilityService(
      registry,
      {
        findByKindergartenId: () => Promise.resolve(bccAccount),
      } as unknown as BccMerchantAccountRepository,
      {
        findByKindergartenId: () =>
          Promise.resolve({ isActive: () => kaspiActive }),
      } as unknown as KaspiMerchantSessionRepository,
    );

    await expect(service.availableForKindergarten(KG_ID)).resolves.toEqual([
      expect.objectContaining({ provider: 'kaspi_pay' }),
    ]);

    bccAccount = bcc('active');
    await expect(service.availableForKindergarten(KG_ID)).resolves.toEqual([
      expect.objectContaining({ provider: 'bcc' }),
      expect.objectContaining({ provider: 'kaspi_pay' }),
    ]);

    kaspiActive = false;
    await expect(service.availableForKindergarten(KG_ID)).resolves.toEqual([
      expect.objectContaining({ provider: 'bcc' }),
    ]);
  });

  it('rejects BCC initiation when the tenant account is disabled', async () => {
    const registry = new PaymentProviderRegistry(
      [{ provider: 'bcc', adapter: adapter() }],
      ['bcc'],
    );
    const service = new PaymentMethodAvailabilityService(
      registry,
      {
        findByKindergartenId: () => Promise.resolve(bcc('disabled')),
      } as unknown as BccMerchantAccountRepository,
      {
        findByKindergartenId: () => Promise.resolve(null),
      } as unknown as KaspiMerchantSessionRepository,
    );

    await expect(service.assertBccActive(KG_ID)).rejects.toMatchObject({
      code: 'bcc_not_connected',
    });
  });
});
