import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const QR_PURPOSE_VALUES = ['identity'] as const;
export type QrPurposeValue = (typeof QR_PURPOSE_VALUES)[number];

/**
 * `user_qr_tokens` row — the DB-side persistence shape for the Identity QR
 * feature (B10). Cross-tenant by design — NO RLS, NO `FORCE ROW LEVEL
 * SECURITY` (a parent with children in multiple kindergartens uses one QR;
 * `kindergarten_id` is therefore nullable).
 *
 * The plaintext token NEVER lives in this table. Only the SHA-256 hex hash
 * (`token_hash`) does. Plaintext is cached in Redis under
 * `qr:token:{plaintext}` with TTL = `expires_at - now` — see
 * `RedisQrTokenCacheAdapter`.
 *
 * Migration: `B10IdentityQr1777688591994`. Indexes + the partial unique
 * `(user_id, purpose) WHERE revoked_at IS NULL` are owned by the migration
 * (TypeORM cannot express the partial predicate via `@Index`). The
 * "exactly one active" invariant is enforced in the service layer via
 * revoke-old-then-insert-new in a single TX.
 */
@Entity({ name: 'user_qr_tokens' })
export class UserQrTokenTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'uuid', nullable: true })
  kindergarten_id!: string | null;

  @Column({
    type: 'enum',
    enum: QR_PURPOSE_VALUES,
    enumName: 'qr_purpose',
    default: 'identity',
  })
  purpose!: QrPurposeValue;

  @Column({ type: 'varchar', length: 64, unique: true })
  token_hash!: string;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  issued_at!: Date;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_scanned_at!: Date | null;
}
