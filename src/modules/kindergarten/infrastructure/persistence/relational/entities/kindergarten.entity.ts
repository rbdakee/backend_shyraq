import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'kindergartens' })
export class KindergartenEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar', unique: true })
  slug!: string;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', nullable: true })
  phone!: string | null;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  settings!: Record<string, unknown>;

  @Column({ type: 'varchar', default: 'standard' })
  plan!: string;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  /**
   * Soft-delete timestamp. Set by `archiveKindergarten`, cleared by
   * `restoreKindergarten`. Coexists with `is_active` (kept in sync) so
   * existing P2 code that filters on `is_active=true` keeps working while
   * P3+ migrates to the timestamp.
   */
  @Column({ type: 'timestamptz', nullable: true })
  archived_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
