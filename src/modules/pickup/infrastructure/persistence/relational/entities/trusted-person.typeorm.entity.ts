import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `trusted_people` row — DB-side persistence shape for the B11 reusable
 * per-child whitelist of authorised pickup persons. Tenant-scoped: RLS
 * policy `tenant_isolation` is enforced by the migration; this entity does
 * not encode it.
 *
 * Migration: `B11PickupAndTrusted1777788800000`. No relations are declared
 * — the domain layer rehydrates by id only via the repo + mapper, and
 * adding `@ManyToOne` here would tempt service code to bypass the port.
 *
 * Lifecycle: see `TrustedPerson` domain aggregate
 * (`isActive` + `revoked_at` + `is_one_time` + `used_at`).
 */
@Entity({ name: 'trusted_people' })
export class TrustedPersonTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @Column({ type: 'uuid' })
  child_id!: string;

  @Column({ type: 'uuid' })
  added_by_user_id!: string;

  @Column({ type: 'text' })
  full_name!: string;

  @Column({ type: 'varchar', length: 20 })
  phone!: string;

  @Column({ type: 'char', length: 12, nullable: true })
  iin!: string | null;

  @Column({ type: 'text' })
  relation!: string;

  @Column({ type: 'text', nullable: true })
  photo_url!: string | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'boolean', default: false })
  is_one_time!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  used_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at!: Date | null;
}
