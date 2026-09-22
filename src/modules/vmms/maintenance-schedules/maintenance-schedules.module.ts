import { Module } from '@nestjs/common';
import SharedModule from '../../../shared/shared.module';
import { MaintenanceSchedulesController } from './maintenance-schedules.controller';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { MaintenanceNotificationsService } from './maintenance-notifications.service';
import { MaintenanceNotificationsController } from './maintenance-notifications.controller';

@Module({
  imports: [SharedModule],
  controllers: [MaintenanceNotificationsController, MaintenanceSchedulesController],
  providers: [MaintenanceSchedulesService, MaintenanceNotificationsService],
})
export class MaintenanceSchedulesModule {}
