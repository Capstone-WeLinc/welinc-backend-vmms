import { MaintenancePriority } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateWorkOrderPriorityDto {
  @IsEnum(MaintenancePriority)
  priority!: MaintenancePriority;
}
