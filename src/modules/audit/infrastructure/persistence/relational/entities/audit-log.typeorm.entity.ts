import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import {
  AuditAction,
  AuditEntityType,
  AuditSnapshot,
} from '../../../../domain/entities/audit-log-entry.entity';

/**
 * audit_log row — append-only mutation trail. RLS-scoped on `kindergarten_id`.
 * The AdminAttendanceAudit migration created indexes on
 *   (kindergarten_id, entity_type, entity_id, created_at DESC) and
 *   (kindergarten_id, created_at DESC) —
 * mirrored here as `@Index` for documentation; TypeORM does not own them.
 *
 * `entity_type` is a plain varchar with no DB check constraint — the column is
 * intentionally open for future modules. `action` IS constrained DB-side by
 * `audit_log_action_chk`.
 */
@Entity({ name: 'audit_log' })
@Index('idx_audit_entity', [
  'kindergarten_id',
  'entity_type',
  'entity_id',
  'created_at',
])
@Index('idx_audit_kg_created', ['kindergarten_id', 'created_at'])
export class AuditLogTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'varchar', length: 64 })
  entity_type!: AuditEntityType;

  @Column({ type: 'uuid' })
  entity_id!: string;

  @Column({ type: 'varchar', length: 32 })
  action!: AuditAction;

  @Column({ type: 'uuid', nullable: true })
  actor_user_id!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_user_id', referencedColumnName: 'id' })
  actorUser?: UserEntity;

  @Column({ type: 'uuid', nullable: true })
  actor_staff_id!: string | null;

  @ManyToOne(() => StaffMemberEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_staff_id', referencedColumnName: 'id' })
  actorStaff?: StaffMemberEntity;

  @Column({ type: 'jsonb', nullable: true })
  before!: AuditSnapshot | null;

  @Column({ type: 'jsonb', nullable: true })
  after!: AuditSnapshot | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
