import { BccMerchantAccount } from '../../domain/entities/bcc-merchant-account.entity';

/**
 * Persistence port for the tenant-scoped BCC merchant account.
 *
 * The callback lookup is intentionally the only cross-tenant method. Its
 * relational implementation opens a fresh bypass-RLS transaction and filters
 * by the exact SHA-256 token hash.
 */
export abstract class BccMerchantAccountRepository {
  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<BccMerchantAccount | null>;

  abstract findByKindergartenId(
    kindergartenId: string,
  ): Promise<BccMerchantAccount | null>;

  abstract findByCallbackTokenHashBypassRls(
    callbackTokenHash: string,
  ): Promise<BccMerchantAccount | null>;

  abstract save(account: BccMerchantAccount): Promise<BccMerchantAccount>;

  /**
   * Persists in a fresh bypass-RLS transaction. Connection-check failures use
   * this path so sanitized diagnostics commit even though the HTTP request
   * subsequently returns a 502 and its ambient transaction rolls back.
   */
  abstract saveBypassRls(
    account: BccMerchantAccount,
  ): Promise<BccMerchantAccount>;
}
