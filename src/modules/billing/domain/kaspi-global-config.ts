/**
 * KaspiGlobalConfig — read-model POJO for the `kaspi_global_config` table.
 *
 * Single-row global configuration (id = 1, NO RLS). Holds Kaspi app-version
 * constants editable by a super-admin at runtime to avoid OldVersionToUpdate
 * gate blocks without re-deploy.
 *
 * This is a plain read-model, NOT a rich aggregate — the table has no
 * domain invariants beyond the single-row constraint (enforced in DB).
 */
export interface KaspiGlobalConfig {
  appVersion: string;
  appBuild: string;
  platformVer: string;
  model: string;
  brand: string;
  uaNative: string;
  uaBrowser: string;
  entranceUrl: string;
  mtokenUrl: string;
  qrpayUrl: string;
  updatedBy: string | null;
  updatedAt: Date;
}

/**
 * Fields that the super-admin may update via PUT /saas/kaspi/config.
 * All optional — a partial patch is merged onto the existing row.
 */
export type KaspiGlobalConfigPatch = Partial<
  Omit<KaspiGlobalConfig, 'updatedBy' | 'updatedAt'>
>;
