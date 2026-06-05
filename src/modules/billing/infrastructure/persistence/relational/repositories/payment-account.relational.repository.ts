import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { PaymentAccount } from '../../../../domain/entities/payment-account.entity';
import { PaymentAccountRepository } from '../../payment-account.repository';
import { PaymentAccountTypeOrmEntity } from '../entities/payment-account.typeorm.entity';
import { PaymentAccountMapper } from '../mappers/payment-account.mapper';

@Injectable()
export class PaymentAccountRelationalRepository extends PaymentAccountRepository {
  constructor(
    @InjectRepository(PaymentAccountTypeOrmEntity)
    private readonly repo: Repository<PaymentAccountTypeOrmEntity>,
  ) {
    super();
  }

  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    return tenantStorage.getStore()?.entityManager ?? this.repo.manager;
  }

  async findOrCreateForChild(
    kindergartenId: string,
    childId: string,
    explicitManager?: EntityManager,
  ): Promise<PaymentAccount> {
    const m = this.manager(explicitManager);
    const repo = m.getRepository(PaymentAccountTypeOrmEntity);

    const existing = await repo.findOne({
      where: { kindergartenId, childId },
    });
    if (existing) return PaymentAccountMapper.toDomain(existing);

    // INSERT ... ON CONFLICT DO NOTHING — concurrent first-creates collapse
    // to the row inserted by whichever TX won the UNIQUE race.
    await m.query(
      `INSERT INTO payment_accounts (kindergarten_id, child_id, balance)
         VALUES ($1, $2, 0)
         ON CONFLICT ON CONSTRAINT uq_payment_accounts_kg_child DO NOTHING`,
      [kindergartenId, childId],
    );
    const after = await repo.findOne({
      where: { kindergartenId, childId },
    });
    if (!after) {
      throw new Error(
        `payment_account_readback_failed:kg=${kindergartenId} child=${childId}`,
      );
    }
    return PaymentAccountMapper.toDomain(after);
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<PaymentAccount | null> {
    const row = await this.manager()
      .getRepository(PaymentAccountTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? PaymentAccountMapper.toDomain(row) : null;
  }

  async findByChildId(
    kindergartenId: string,
    childId: string,
  ): Promise<PaymentAccount | null> {
    const row = await this.manager()
      .getRepository(PaymentAccountTypeOrmEntity)
      .findOne({ where: { childId, kindergartenId } });
    return row ? PaymentAccountMapper.toDomain(row) : null;
  }

  async save(account: PaymentAccount): Promise<PaymentAccount> {
    const s = account.toState();
    await this.manager()
      .getRepository(PaymentAccountTypeOrmEntity)
      .update(
        { id: s.id, kindergartenId: s.kindergartenId },
        { balance: s.balance, updatedAt: s.updatedAt },
      );
    return account;
  }

  /**
   * `pg_advisory_xact_lock(hashtext('billing:account:'||accountId)::bigint)`.
   * Released on TX commit / rollback. Goes through `manager()` so it inherits
   * the ambient settlement TX (parent-pay / webhook / refund path). Mirrors
   * `PaymentRelationalRepository.acquirePaymentAdvisoryLock` — see that file's
   * canonical M11 note for why the `::bigint` cast is present. Serialises
   * concurrent credit/debit on the SAME per-child account; the per-invoice
   * lock does not cover this.
   */
  async acquireBalanceAdvisoryLock(
    _kindergartenId: string,
    accountId: string,
  ): Promise<void> {
    const scope = `billing:account:${accountId}`;
    await this.manager().query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
      [scope],
    );
  }
}
