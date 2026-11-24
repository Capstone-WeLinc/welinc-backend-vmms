import { Module } from '@nestjs/common';
import SharedModule from '../../../../shared/shared.module';
import { MaintenanceSchedulesModule } from '../../maintenance-schedules/maintenance-schedules.module';
import { BmsAvailabilityModule } from '../bms/bms-availability.module';
import { VrmsRepairEventsController } from './vrms-repair-events.controller';
import { VrmsRepairReferralEventsController } from './vrms-repair-referral-events.controller';
import { VrmsRepairEventsService } from './vrms-repair-events.service';

@Module({
  imports: [SharedModule, MaintenanceSchedulesModule, BmsAvailabilityModule],
  controllers: [
    VrmsRepairEventsController,
    VrmsRepairReferralEventsController,
  ],
  providers: [VrmsRepairEventsService],
})
export class VrmsRepairEventsModule {}
