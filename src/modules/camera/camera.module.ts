import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AllConfigType } from '@/config/config.type';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { LocationModule } from '@/modules/location/location.module';
import { ScheduleModule } from '@/modules/schedule/schedule.module';
import {
  CAMERA_CODEC_PROBE_QUEUE,
  CameraCodecProbeProcessor,
  CameraCodecProbeScheduler,
} from './camera-codec-probe.processor';
import { CameraController } from './camera.controller';
import { CctvStreamController } from './cctv-stream.controller';
import { CctvStreamTokenService } from './cctv-stream-token.service';
import { ParentCctvController } from './parent-cctv.controller';
import { ParentCctvService } from './parent-cctv.service';
import { CameraRepository } from './infrastructure/persistence/camera.repository';
import { CameraService } from './camera.service';
import { CameraEntity } from './infrastructure/persistence/relational/entities/camera.entity';
import { CameraRelationalRepository } from './infrastructure/persistence/relational/repositories/camera.repository';
import { Go2rtcMediaGatewayAdapter } from './infrastructure/media-gateway/go2rtc-media-gateway.adapter';
import { MockMediaGatewayAdapter } from './infrastructure/media-gateway/mock-media-gateway.adapter';
import { MediaGatewayPort } from './media-gateway.port';

@Module({
  imports: [
    TypeOrmModule.forFeature([CameraEntity]),
    BullModule.registerQueue({ name: CAMERA_CODEC_PROBE_QUEUE }),
    LocationModule,
    // Parent CCTV walks child → group → location before it reaches a camera.
    ChildModule,
    GroupModule,
    // …and asks the schedule which location that is at this instant, falling
    // back to the group's hand-set one only when nothing is scheduled.
    ScheduleModule,
  ],
  controllers: [CameraController, ParentCctvController, CctvStreamController],
  providers: [
    CameraService,
    ParentCctvService,
    CctvStreamTokenService,
    {
      provide: CameraRepository,
      useClass: CameraRelationalRepository,
    },
    {
      // Mirrors the SmsPort wiring in AuthModule: mock by default so a
      // developer without a tunnel to a kindergarten still boots.
      provide: MediaGatewayPort,
      inject: [ConfigService],
      useFactory: (cs: ConfigService<AllConfigType>) => {
        const provider = cs.get('cctv.mediaGateway', { infer: true }) ?? 'mock';
        if (provider === 'go2rtc') {
          const cfg = cs.get('cctv.go2rtc', { infer: true });
          if (!cfg) {
            throw new Error(
              'CCTV_MEDIA_GATEWAY=go2rtc but cctv.go2rtc config is null',
            );
          }
          return new Go2rtcMediaGatewayAdapter(cfg);
        }
        return new MockMediaGatewayAdapter();
      },
    },
    CameraCodecProbeProcessor,
    CameraCodecProbeScheduler,
  ],
  exports: [CameraRepository, CameraService, MediaGatewayPort],
})
export class CameraModule {}
