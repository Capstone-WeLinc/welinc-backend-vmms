import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class UpdateMaintenanceOdometerThresholdDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  thresholdKm!: number;

  @IsString()
  @Matches(/\S/, { message: 'A reason for changing the odometer threshold is required.' })
  @MaxLength(2000)
  reason!: string;
}
