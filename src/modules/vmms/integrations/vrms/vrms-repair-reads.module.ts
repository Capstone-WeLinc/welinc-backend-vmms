import { Module } from '@nestjs/common';
import SharedModule from '../../../../shared/shared.module';
import { VrmsRepairReadsService } from './vrms-repair-reads.service';

@Module({
  imports: [SharedModule],
  providers: [VrmsRepairReadsService],
  exports: [VrmsRepairReadsService],
})
export class VrmsRepairReadsModule {}
