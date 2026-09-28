import { IsString, Matches, MaxLength } from 'class-validator';

export class CancelMaintenanceScheduleDto {
  @IsString()
  @Matches(/\S/, { message: 'A cancellation reason is required.' })
  @MaxLength(2000)
  reason!: string;
}
