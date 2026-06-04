import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const KASPI_SESSION_STATUS_VALUES = [
  'pending',
  'active',
  'expired',
  'revoked',
] as const;

export type KaspiSessionStatusValue =
  (typeof KASPI_SESSION_STATUS_VALUES)[number];

/**
 * `kaspi_merchant_session` row (B24). One row per kindergarten (UNIQUE
 * kindergarten_id). FORCE ROW LEVEL SECURITY — tenant_isolation policy applies.
 *
 * The `*_enc` columns are AES-256-GCM base64 blobs produced by
 * `CryptoCipherPort` (K1). They are opaque text at this layer — no transformer,
 * no decryption here. Migration: `1778680000000-B24KaspiPay.ts`.
 */
@Entity({ name: 'kaspi_merchant_session' })
export class KaspiMerchantSessionTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'connected_by_user_id', type: 'uuid' })
  connectedByUserId!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: KASPI_SESSION_STATUS_VALUES,
    enumName: 'kaspi_session_status',
    default: 'pending',
  })
  status!: KaspiSessionStatusValue;

  @Column({ name: 'cashier_phone', type: 'varchar', nullable: true })
  cashierPhone!: string | null;

  @Column({ name: 'kaspi_profile_id', type: 'varchar', nullable: true })
  kaspiProfileId!: string | null;

  @Column({ name: 'kaspi_org_id', type: 'varchar', nullable: true })
  kaspiOrgId!: string | null;

  @Column({ name: 'org_name', type: 'varchar', nullable: true })
  orgName!: string | null;

  @Column({ name: 'token_sn', type: 'text', nullable: true })
  tokenSn!: string | null;

  @Column({ name: 'vtoken_secret_enc', type: 'text', nullable: true })
  vtokenSecretEnc!: string | null;

  @Column({ name: 'device_keypair_enc', type: 'text', nullable: true })
  deviceKeypairEnc!: string | null;

  @Column({ name: 'ecdh_keypair_enc', type: 'text', nullable: true })
  ecdhKeypairEnc!: string | null;

  @Column({ name: 'device_id', type: 'varchar', nullable: true })
  deviceId!: string | null;

  @Column({ name: 'install_id', type: 'varchar', nullable: true })
  installId!: string | null;

  @Column({ name: 'pin_hash', type: 'varchar', nullable: true })
  pinHash!: string | null;

  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt!: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  updatedAt!: Date;
}
