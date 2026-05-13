import {
  CustomDiscountApplication,
  CustomDiscountApplicationState,
} from '../../../../domain/entities/custom-discount-application.entity';
import { CustomDiscountApplicationTypeOrmEntity } from '../entities/custom-discount-application.typeorm.entity';

export class CustomDiscountApplicationMapper {
  static toDomain(
    row: CustomDiscountApplicationTypeOrmEntity,
  ): CustomDiscountApplication {
    const state: CustomDiscountApplicationState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      customDiscountId: row.customDiscountId,
      invoiceId: row.invoiceId,
      invoiceLineItemId: row.invoiceLineItemId,
      childId: row.childId,
      // Transformer hands `MoneyKzt` directly — pass through.
      amountApplied: row.amountApplied,
      appliedAt: row.appliedAt,
    };
    return CustomDiscountApplication.fromState(state);
  }
}
