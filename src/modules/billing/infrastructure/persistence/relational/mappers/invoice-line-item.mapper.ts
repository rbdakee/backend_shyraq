import {
  InvoiceLineItem,
  InvoiceLineItemState,
} from '../../../../domain/entities/invoice-line-item.entity';
import { InvoiceLineItemTypeOrmEntity } from '../entities/invoice-line-item.typeorm.entity';

export class InvoiceLineItemMapper {
  static toDomain(row: InvoiceLineItemTypeOrmEntity): InvoiceLineItem {
    const state: InvoiceLineItemState = {
      id: row.id,
      invoiceId: row.invoiceId,
      kindergartenId: row.kindergartenId,
      description: row.description,
      tariffPlanId: row.tariffPlanId,
      quantity: Number(row.quantity),
      // Transformer hands `MoneyKzt` directly — pass through.
      unitPrice: row.unitPrice,
      lineTotal: row.lineTotal,
      createdAt: row.createdAt,
    };
    return InvoiceLineItem.fromState(state);
  }
}
