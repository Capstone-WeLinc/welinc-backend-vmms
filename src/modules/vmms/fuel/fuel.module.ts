import { Module } from '@nestjs/common';
import SharedModule from '../../../shared/shared.module';
import { FuelController } from './fuel.controller';
import { FuelService } from './fuel.service';
import { FuelEscalationService } from './fuel-escalation.service';
import { FuelReceiptScannerService } from './fuel-receipt-scanner.service';
import { VrmsRepairReferralsModule } from '../integrations/vrms/vrms-repair-referrals.module';

@Module({
  imports: [SharedModule, VrmsRepairReferralsModule],
  controllers: [FuelController],
  providers: [FuelService, FuelEscalationService, FuelReceiptScannerService],
  exports: [FuelService],
})
export class FuelModule {}
