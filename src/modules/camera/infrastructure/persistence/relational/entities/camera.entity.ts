import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { VideoCodec } from '../../../../domain/value-objects/video-codec.vo';

@Entity({ name: 'cameras' })
@Index('idx_cameras_kg', ['kindergarten_id'])
@Index('idx_cameras_location', ['location_id'])
export class CameraEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'uuid' })
  location_id!: string;

  @ManyToOne(() => LocationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id', referencedColumnName: 'id' })
  location?: LocationEntity;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 1000 })
  rtsp_url!: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  hls_url!: string | null;

  // Media-gateway stream keys. Globally unique (not per tenant) — see the
  // CctvStreamMetadata migration for why.
  @Column({ type: 'varchar', length: 128, nullable: true })
  stream_key!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  stream_key_hd!: string | null;

  // Written by the codec-probe job only, never by a human-facing write path.
  @Column({ type: 'varchar', length: 16, nullable: true })
  video_codec!: VideoCodec | null;

  @Column({ type: 'timestamptz', nullable: true })
  codec_checked_at!: Date | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  archived_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
