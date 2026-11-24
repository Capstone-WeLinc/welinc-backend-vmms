import { Module } from '@nestjs/common';
import SharedModule from '../../../shared/shared.module';
import { MaintenanceCostingController } from './maintenance-costing.controller';
import { MaintenanceCostingService } from './maintenance-costing.service';

@Module({
  imports: [SharedModule],
  controllers: [MaintenanceCostingController],
  providers: [MaintenanceCostingService],
  exports: [MaintenanceCostingService],
})
export class MaintenanceCostingModule {}
