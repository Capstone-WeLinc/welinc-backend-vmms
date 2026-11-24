import { Module } from '@nestjs/common';
import SharedModule from '../../../../shared/shared.module';
import { VrmsRepairReferralsController } from './vrms-repair-referrals.controller';
import { VrmsRepairReferralsService } from './vrms-repair-referrals.service';

@Module({
  imports: [SharedModule],
  controllers: [VrmsRepairReferralsController],
  providers: [VrmsRepairReferralsService],
  exports: [VrmsRepairReferralsService],
})
export class VrmsRepairReferralsModule {}
