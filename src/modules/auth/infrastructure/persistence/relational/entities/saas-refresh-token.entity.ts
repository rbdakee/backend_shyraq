import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'saas_refresh_tokens' })
@Index(['saas_user_id'])
export class SaasRefreshTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  saas_user_id!: string;

  @Column({ type: 'varchar', unique: true })
  token_hash!: string;

  @Column({ type: 'varchar', nullable: true })
  device_id!: string | null;

  @Column({ type: 'varchar', nullable: true })
  ip_address!: string | null;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
