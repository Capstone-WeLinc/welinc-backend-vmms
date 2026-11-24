import { Module } from '@nestjs/common';
import SharedModule from '../../../../shared/shared.module';
import { BmsAvailabilityService } from './bms-availability.service';
import { BmsFleetChangesService } from './bms-fleet-changes.service';

@Module({
  imports: [SharedModule],
  providers: [BmsAvailabilityService, BmsFleetChangesService],
  exports: [BmsAvailabilityService, BmsFleetChangesService],
})
export class BmsAvailabilityModule {}
