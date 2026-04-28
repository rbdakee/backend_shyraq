import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type SaasUserRole = 'super_admin' | 'support';

@Entity({ name: 'saas_users' })
export class SaasUserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  email!: string;

  @Column({ type: 'varchar', length: 20, unique: true, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar' })
  full_name!: string;

  @Column({ type: 'varchar' })
  password_hash!: string;

  @Column({ type: 'enum', enum: ['super_admin', 'support'] })
  role!: SaasUserRole;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  last_login_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
