import { Module } from '@nestjs/common';
import SharedModule from '../../../shared/shared.module';
import { FuelController } from './fuel.controller';
import { FuelService } from './fuel.service';
import { FuelEscalationService } from './fuel-escalation.service';
import { FuelReceiptScannerService } from './fuel-receipt-scanner.service';

@Module({
  imports: [SharedModule],
  controllers: [FuelController],
  providers: [FuelService, FuelEscalationService, FuelReceiptScannerService],
})
export class FuelModule {}
