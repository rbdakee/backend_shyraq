import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const PARENT_REQUEST_TYPE_VALUES = [
  'trusted_person',
  'day_off',
  'vacation',
  'late_pickup',
  'open_request',
] as const;

export type ParentRequestTypeValue =
  (typeof PARENT_REQUEST_TYPE_VALUES)[number];

export const PARENT_REQUEST_STATUS_VALUES = [
  'pending',
  'accepted',
  'rejected',
  'cancelled',
] as const;

export type ParentRequestStatusValue =
  (typeof PARENT_REQUEST_STATUS_VALUES)[number];

/**
 * `parent_requests` row — DB-side persistence shape for the B12 parent-request
 * feature. Tenant-scoped via `kindergarten_id` + RLS policy `tenant_isolation`.
 *
 * `invoice_id` is stored as a plain uuid with NO FK — the `invoices` table is
 * created in B13; B13 will add the FK constraint via ALTER TABLE.
 *
 * No TypeORM relations are declared (kept minimal — service layer composes
 * cross-entity lookups explicitly via repository calls).
 */
@Entity({ name: 'parent_requests' })
export class ParentRequestTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'child_id', type: 'uuid' })
  childId!: string;

  @Column({ name: 'requester_user_id', type: 'uuid' })
  requesterUserId!: string;

  @Column({
    name: 'request_type',
    type: 'enum',
    enum: PARENT_REQUEST_TYPE_VALUES,
    enumName: 'parent_request_type',
  })
  requestType!: ParentRequestTypeValue;

  @Column({
    name: 'status',
    type: 'enum',
    enum: PARENT_REQUEST_STATUS_VALUES,
    enumName: 'parent_request_status',
    default: 'pending',
  })
  status!: ParentRequestStatusValue;

  @Column({ name: 'date_from', type: 'date', nullable: true })
  dateFrom!: Date | null;

  @Column({ name: 'date_to', type: 'date', nullable: true })
  dateTo!: Date | null;

  @Column({ name: 'details', type: 'jsonb', default: '{}' })
  details!: Record<string, unknown>;

  @Column({
    name: 'recipient_type',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  recipientType!: 'admin' | 'mentor' | 'specialist' | null;

  @Column({ name: 'recipient_staff_id', type: 'uuid', nullable: true })
  recipientStaffId!: string | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy!: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @Column({ name: 'review_note', type: 'text', nullable: true })
  reviewNote!: string | null;

  @Column({ name: 'invoice_id', type: 'uuid', nullable: true })
  invoiceId!: string | null;

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
