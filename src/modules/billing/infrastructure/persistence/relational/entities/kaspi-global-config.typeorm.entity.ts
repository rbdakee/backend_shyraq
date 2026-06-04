import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * TypeORM entity for `kaspi_global_config`.
 *
 * Global single-row table (id = 1, CHECK chk_kaspi_global_config_singleton).
 * NO RLS — this table is intentionally cross-tenant; both the super-admin API
 * and the Kaspi adapters in tenant context read it.
 *
 * PrimaryColumn (not PrimaryGeneratedColumn) because the PK is a fixed int
 * enforced by the DB-level singleton CHECK.
 */
@Entity({ name: 'kaspi_global_config' })
export class KaspiGlobalConfigTypeOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'int' })
  id!: number;

  @Column({ name: 'app_version', type: 'varchar' })
  appVersion!: string;

  @Column({ name: 'app_build', type: 'varchar' })
  appBuild!: string;

  @Column({ name: 'platform_ver', type: 'varchar' })
  platformVer!: string;

  @Column({ name: 'model', type: 'varchar' })
  model!: string;

  @Column({ name: 'brand', type: 'varchar' })
  brand!: string;

  @Column({ name: 'ua_native', type: 'varchar' })
  uaNative!: string;

  @Column({ name: 'ua_browser', type: 'varchar' })
  uaBrowser!: string;

  @Column({ name: 'entrance_url', type: 'varchar' })
  entranceUrl!: string;

  @Column({ name: 'mtoken_url', type: 'varchar' })
  mtokenUrl!: string;

  @Column({ name: 'qrpay_url', type: 'varchar' })
  qrpayUrl!: string;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
