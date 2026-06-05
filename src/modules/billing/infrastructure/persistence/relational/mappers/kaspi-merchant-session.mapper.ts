import {
  KaspiMerchantSession,
  KaspiMerchantSessionState,
} from '../../../../domain/entities/kaspi-merchant-session.entity';
import { KaspiMerchantSessionTypeOrmEntity } from '../entities/kaspi-merchant-session.typeorm.entity';

/**
 * Domain ↔ TypeORM mapper for `kaspi_merchant_session` (B24 / K5). Straight
 * field copy — the `*_enc` blobs are opaque base64 strings on both sides.
 */
export class KaspiMerchantSessionMapper {
  static toDomain(
    row: KaspiMerchantSessionTypeOrmEntity,
  ): KaspiMerchantSession {
    const state: KaspiMerchantSessionState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      connectedByUserId: row.connectedByUserId,
      status: row.status,
      cashierPhone: row.cashierPhone,
      kaspiProfileId: row.kaspiProfileId,
      kaspiOrgId: row.kaspiOrgId,
      orgName: row.orgName,
      tokenSn: row.tokenSn,
      vtokenSecretEnc: row.vtokenSecretEnc,
      deviceKeypairEnc: row.deviceKeypairEnc,
      ecdhKeypairEnc: row.ecdhKeypairEnc,
      deviceId: row.deviceId,
      installId: row.installId,
      pinHash: row.pinHash,
      lastCheckedAt: row.lastCheckedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return KaspiMerchantSession.fromState(state);
  }
}
