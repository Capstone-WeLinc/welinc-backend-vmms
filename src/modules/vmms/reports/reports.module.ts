import { Module } from '@nestjs/common';
import SharedModule from '../../../shared/shared.module';
import { ReportsController } from './reports.controller';
import { ScheduledReportsService } from './scheduled-reports.service';

@Module({
  imports: [SharedModule],
  controllers: [ReportsController],
  providers: [ScheduledReportsService],
})
export class ReportsModule {}
