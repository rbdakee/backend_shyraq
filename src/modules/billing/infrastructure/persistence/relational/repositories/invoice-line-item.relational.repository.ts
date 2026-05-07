import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { InvoiceLineItem } from '../../../../domain/entities/invoice-line-item.entity';
import { InvoiceLineItemRepository } from '../../invoice-line-item.repository';
import { InvoiceLineItemTypeOrmEntity } from '../entities/invoice-line-item.typeorm.entity';
import { InvoiceLineItemMapper } from '../mappers/invoice-line-item.mapper';

@Injectable()
export class InvoiceLineItemRelationalRepository extends InvoiceLineItemRepository {
  constructor(
    @InjectRepository(InvoiceLineItemTypeOrmEntity)
    private readonly repo: Repository<InvoiceLineItemTypeOrmEntity>,
  ) {
    super();
  }

  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }

  async createMany(
    items: InvoiceLineItem[],
    explicitManager?: EntityManager,
  ): Promise<InvoiceLineItem[]> {
    if (items.length === 0) return [];
    const m = this.manager(explicitManager).getRepository(
      InvoiceLineItemTypeOrmEntity,
    );
    await m.insert(
      items.map((li) => {
        const s = li.toState();
        return {
          id: s.id,
          invoiceId: s.invoiceId,
          kindergartenId: s.kindergartenId,
          description: s.description,
          tariffPlanId: s.tariffPlanId,
          quantity: s.quantity,
          unitPrice: s.unitPrice,
          lineTotal: s.lineTotal,
          createdAt: s.createdAt,
        };
      }),
    );
    return items;
  }

  async listByInvoice(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<InvoiceLineItem[]> {
    const rows = await this.manager()
      .getRepository(InvoiceLineItemTypeOrmEntity)
      .find({
        where: { invoiceId, kindergartenId },
        order: { createdAt: 'ASC' },
      });
    return rows.map(InvoiceLineItemMapper.toDomain);
  }
}
