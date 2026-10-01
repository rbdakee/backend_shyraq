import {
  CctvDisplayPolicy,
  CctvHideRule,
} from '../../domain/entities/cctv-display-policy.entity';

export interface SaveCctvDisplayPolicyInput {
  commonCameraIds: string[];
  hideRules: CctvHideRule[];
}

/**
 * Port over `cctv_display_policies`. At most one row per kindergarten — the
 * absence of a row is a valid state meaning "the defaults", so `find` returning
 * null is normal rather than an error, and there is no create/update pair.
 */
export abstract class CctvDisplayPolicyRepository {
  abstract findByKindergarten(
    kindergartenId: string,
  ): Promise<CctvDisplayPolicy | null>;

  abstract upsert(
    kindergartenId: string,
    input: SaveCctvDisplayPolicyInput,
  ): Promise<CctvDisplayPolicy>;
}
