import { Module } from '@nestjs/common';
import SharedModule from '../../../shared/shared.module';
import { MaintenanceSchedulesController } from './maintenance-schedules.controller';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { MaintenanceNotificationsService } from './maintenance-notifications.service';
import { MaintenanceNotificationsController } from './maintenance-notifications.controller';
import { MaintenanceOverdueService } from './maintenance-overdue.service';
import { MaintenancePredictionsController } from './maintenance-predictions.controller';
import { MaintenancePredictionsService } from './maintenance-predictions.service';

@Module({
  imports: [SharedModule],
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
})
export class MaintenanceSchedulesModule {}
