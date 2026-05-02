import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const PICKUP_REQUEST_STATUS_VALUES = [
  'otp_sent',
  'validated',
  'expired',
  'cancelled',
] as const;
export type PickupRequestStatusValue =
  (typeof PICKUP_REQUEST_STATUS_VALUES)[number];

/**
 * `pickup_requests` row — DB-side persistence shape for the B11 OTP-based
 * pickup-request flow. Tenant-scoped via `kindergarten_id` + RLS policy
 * `tenant_isolation` (owned by the migration).
 *
 * `parent_request_id` is intentionally a plain uuid with NO FK in the DB
 * yet — the `parent_requests` table arrives in B12, at which point a
 * follow-up migration adds the FK constraint. The domain treats it as an
 * opaque correlation id.
 *
 * `attendance_event_id` becomes non-null only after staff successfully
 * validates the OTP (`validate` transition) — the surrounding service
 * call writes the attendance row first, then stamps its id back here.
 */
@Entity({ name: 'pickup_requests' })
export class PickupRequestTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @Column({ type: 'uuid' })
  child_id!: string;

  @Column({ type: 'uuid' })
  requested_by_user_id!: string;

  @Column({ type: 'uuid', nullable: true })
  trusted_person_id!: string | null;

  @Column({ type: 'varchar', length: 20 })
  trusted_person_phone!: string;

  @Column({ type: 'text' })
  trusted_person_name!: string;

  @Column({ type: 'char', length: 12, nullable: true })
  trusted_person_iin!: string | null;

  @Column({ type: 'text', nullable: true })
  otp_ref!: string | null;

  @Column({
    type: 'enum',
    enum: PICKUP_REQUEST_STATUS_VALUES,
    enumName: 'pickup_request_status',
    default: 'otp_sent',
  })
  status!: PickupRequestStatusValue;

  @Column({ type: 'uuid', nullable: true })
  validated_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  validated_at!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  attendance_event_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  parent_request_id!: string | null;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  created_at!: Date;
}
