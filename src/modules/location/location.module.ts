import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocationEntity } from './infrastructure/persistence/relational/entities/location.entity';
import { LocationRelationalRepository } from './infrastructure/persistence/relational/repositories/location.repository';
import { LocationController } from './location.controller';
import { LocationRepository } from './infrastructure/persistence/location.repository';
import { LocationService } from './location.service';

@Module({
  imports: [TypeOrmModule.forFeature([LocationEntity])],
  controllers: [LocationController],
  providers: [
    LocationService,
    {
      provide: LocationRepository,
      useClass: LocationRelationalRepository,
    },
  ],
  exports: [LocationRepository, LocationService],
})
export class LocationModule {}
