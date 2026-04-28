import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'users' })
@Index(['phone'])
@Index(['iin'])
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20, unique: true })
  phone!: string;

  @Column({ type: 'varchar' })
  full_name!: string;

  @Column({ type: 'text', nullable: true })
  avatar_url!: string | null;

  @Column({ type: 'char', length: 12, unique: true, nullable: true })
  iin!: string | null;

  @Column({ type: 'date', nullable: true })
  date_of_birth!: string | null;

  @Column({ type: 'varchar', length: 5, default: 'ru' })
  locale!: 'ru' | 'kk';

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  last_login_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
