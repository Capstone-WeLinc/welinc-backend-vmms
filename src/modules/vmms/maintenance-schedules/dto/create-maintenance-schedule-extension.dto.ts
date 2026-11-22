import { IsString, Matches, MaxLength } from 'class-validator';

export class CreateMaintenanceScheduleExtensionDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'A valid target due date in YYYY-MM-DD format is required.',
  })
  requestedDueDate!: string;

  @IsString()
  @Matches(/\S/, { message: 'A request reason is required.' })
  @MaxLength(2000)
  reason!: string;
}
