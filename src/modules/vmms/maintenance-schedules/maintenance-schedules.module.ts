import { Module } from '@nestjs/common';
import SharedModule from '../../../shared/shared.module';
import { MaintenanceSchedulesController } from './maintenance-schedules.controller';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { MaintenanceNotificationsService } from './maintenance-notifications.service';
import { MaintenanceNotificationsController } from './maintenance-notifications.controller';
import { MaintenanceOverdueService } from './maintenance-overdue.service';
import { MaintenancePredictionsController } from './maintenance-predictions.controller';
import { MaintenancePredictionsService } from './maintenance-predictions.service';
import { BmsAvailabilityModule } from '../integrations/bms/bms-availability.module';
import { VrmsRepairReferralsModule } from '../integrations/vrms/vrms-repair-referrals.module';
import { VrmsRepairReadsModule } from '../integrations/vrms/vrms-repair-reads.module';

@Module({
  imports: [
    SharedModule,
    BmsAvailabilityModule,
    VrmsRepairReferralsModule,
    VrmsRepairReadsModule,
  ],
  controllers: [
    MaintenancePredictionsController,
    MaintenanceNotificationsController,
    MaintenanceSchedulesController,
  ],
  providers: [
    MaintenanceSchedulesService,
    MaintenanceNotificationsService,
    MaintenanceOverdueService,
    MaintenancePredictionsService,
  ],
  exports: [MaintenanceSchedulesService],
})
export class MaintenanceSchedulesModule {}
