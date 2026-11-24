import { Module } from '@nestjs/common';
import SharedModule from '../../../shared/shared.module';
import { FuelModule } from '../fuel/fuel.module';
import { MaintenanceCostingModule } from '../maintenance-costing/maintenance-costing.module';
import { SettingsCatalogController } from './settings.controller';
import { SettingsCatalogService } from './settings.service';

@Module({
  imports: [SharedModule, FuelModule, MaintenanceCostingModule],
  controllers: [SettingsCatalogController],
  providers: [SettingsCatalogService],
})
export class SettingsModule {}
