import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocationModule } from '@/modules/location/location.module';
import { CameraController } from './camera.controller';
import { CameraRepository } from './camera.repository';
import { CameraService } from './camera.service';
import { CameraEntity } from './infrastructure/persistence/relational/entities/camera.entity';
import { CameraRelationalRepository } from './infrastructure/persistence/relational/repositories/camera.repository';

@Module({
  imports: [TypeOrmModule.forFeature([CameraEntity]), LocationModule],
  controllers: [CameraController],
  providers: [
    CameraService,
    {
      provide: CameraRepository,
      useClass: CameraRelationalRepository,
    },
  ],
  exports: [CameraRepository, CameraService],
})
export class CameraModule {}
