import { Module } from '@nestjs/common';
import SharedModule from '../../shared/shared.module.js';
import { VmmsConfigController } from './config/config.controller.js';
import { VmmsConfigService } from './config/config.service.js';
import { ChecklistsModule } from './checklists/checklists.module';
import { MaintenanceSchedulesModule } from './maintenance-schedules/maintenance-schedules.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { LocationsModule } from './locations/locations.module';
import { MaintenanceCostingModule } from './maintenance-costing/maintenance-costing.module';
import { FuelModule } from './fuel/fuel.module';
import { AuthDirectoryClient } from './directory/auth-directory.client';
import {
  DirectoryPollJob,
  DirectorySync,
} from './directory/directory-sync.service';
import { MechanicsController } from './directory/mechanics.controller';
import { FleetController } from './fleet/fleet.controller';
import { AuditController } from './audit/audit.controller';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    SharedModule,
    MaintenanceSchedulesModule,
    ChecklistsModule,
    VehiclesModule,
    LocationsModule,
    MaintenanceCostingModule,
    FuelModule,
    ReportsModule,
  ],
  controllers: [
    VmmsConfigController,
    MechanicsController,
    FleetController,
    AuditController,
  ],
  providers: [
    VmmsConfigService,
    AuthDirectoryClient,
    DirectorySync,
    DirectoryPollJob,
  ],
})
export class VmmsModule {}
