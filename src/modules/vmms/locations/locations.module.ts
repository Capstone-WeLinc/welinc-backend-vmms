import { Module } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { LocationsController } from './locations.controller';
import SharedModule from '../../../shared/shared.module';
import { BmsAvailabilityModule } from '../integrations/bms/bms-availability.module';

@Module({
  imports: [SharedModule, BmsAvailabilityModule],
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
