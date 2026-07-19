import { Module } from '@nestjs/common';
import SharedModule from '../../../shared/shared.module';
import { MaintenanceSchedulesController } from './maintenance-schedules.controller';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

@Module({
  imports: [SharedModule],
  controllers: [MaintenanceSchedulesController],
  providers: [MaintenanceSchedulesService],
})
export class MaintenanceSchedulesModule {}
