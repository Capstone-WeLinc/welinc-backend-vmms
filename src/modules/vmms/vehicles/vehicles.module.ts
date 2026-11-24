import { Module } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehiclesController } from './vehicles.controller';
import SharedModule from '../../../shared/shared.module';
import { BmsAvailabilityModule } from '../integrations/bms/bms-availability.module';
import { VrmsRepairReadsModule } from '../integrations/vrms/vrms-repair-reads.module';

@Module({
  imports: [SharedModule, BmsAvailabilityModule, VrmsRepairReadsModule],
  controllers: [VehiclesController],
  providers: [VehiclesService],
})
export class VehiclesModule {}
