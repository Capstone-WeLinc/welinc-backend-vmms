import { Module } from '@nestjs/common';
import SharedModule from '../../shared/shared.module.js';
import { VmmsConfigController } from './config/config.controller.js';
import { VmmsConfigService } from './config/config.service.js';
import UsersModule from './users/users.module';
import { ChecklistsModule } from './checklists/checklists.module';
import { MaintenanceSchedulesModule } from './maintenance-schedules/maintenance-schedules.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { LocationsModule } from './locations/locations.module';
import { MaintenanceCostingModule } from './maintenance-costing/maintenance-costing.module';
import { FuelModule } from './fuel/fuel.module';

@Module({
  imports: [
    SharedModule,
    UsersModule,
    MaintenanceSchedulesModule,
    ChecklistsModule,
    VehiclesModule,
    LocationsModule,
    MaintenanceCostingModule,
    FuelModule,
  ],
  controllers: [VmmsConfigController],
  providers: [VmmsConfigService],
})
export class VmmsModule {}
