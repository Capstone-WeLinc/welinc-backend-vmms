import { Module } from '@nestjs/common';
import SharedModule from '../../../../shared/shared.module';
import { MaintenanceSchedulesModule } from '../../maintenance-schedules/maintenance-schedules.module';
import { BmsAvailabilityModule } from '../bms/bms-availability.module';
import { VrmsRepairEventsController } from './vrms-repair-events.controller';
import { VrmsRepairReferralEventsController } from './vrms-repair-referral-events.controller';
import { VrmsRepeatRepairAlertsController } from './vrms-repeat-repair-alerts.controller';
import { VrmsRepeatRepairAlertsQueryController } from './vrms-repeat-repair-alerts-query.controller';
import { VrmsRetirementOperationsController } from './vrms-retirement-operations.controller';
import { VrmsRetirementRequestsController } from './vrms-retirement-requests.controller';
import { VrmsRepeatRepairAlertsService } from './vrms-repeat-repair-alerts.service';
import { VrmsRetirementRequestsService } from './vrms-retirement-requests.service';
import { VrmsRepairEventsService } from './vrms-repair-events.service';

@Module({
  imports: [SharedModule, MaintenanceSchedulesModule, BmsAvailabilityModule],
  controllers: [
    VrmsRepairEventsController,
    VrmsRepairReferralEventsController,
    VrmsRetirementRequestsController,
    VrmsRetirementOperationsController,
    VrmsRepeatRepairAlertsController,
    VrmsRepeatRepairAlertsQueryController,
  ],
  providers: [
    VrmsRepairEventsService,
    VrmsRetirementRequestsService,
    VrmsRepeatRepairAlertsService,
  ],
})
export class VrmsRepairEventsModule {}
