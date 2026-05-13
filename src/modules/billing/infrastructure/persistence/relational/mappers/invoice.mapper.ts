import {
  Invoice,
  InvoiceState,
} from '../../../../domain/entities/invoice.entity';
import { InvoiceTypeOrmEntity } from '../entities/invoice.typeorm.entity';
import { toDate } from './date-utils';

export class InvoiceMapper {
  static toDomain(row: InvoiceTypeOrmEntity): Invoice {
    const state: InvoiceState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      childId: row.childId,
      paymentAccountId: row.paymentAccountId,
      tariffPlanId: row.tariffPlanId,
      invoiceType: row.invoiceType,
      periodStart: toDate(row.periodStart),
      periodEnd: toDate(row.periodEnd),
      // Transformer hands `MoneyKzt` directly — pass through.
      amountDue: row.amountDue,
      discountPct: row.discountPct === null ? null : Number(row.discountPct),
      discountReason: row.discountReason,
      amountAfterDiscount: row.amountAfterDiscount,
      status: row.status,
      dueDate: toDate(row.dueDate),
      description: row.description,
      proratedForDays: row.proratedForDays,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return Invoice.fromState(state);
  }
}
