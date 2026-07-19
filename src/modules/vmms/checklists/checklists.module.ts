import { Module } from '@nestjs/common';
import { ChecklistsService } from './checklists.service';
import { ChecklistsController } from './checklists.controller';
import SharedModule from '../../../shared/shared.module';

@Module({
  imports: [SharedModule],
  controllers: [ChecklistsController],
  providers: [ChecklistsService],
})
export class ChecklistsModule {}
