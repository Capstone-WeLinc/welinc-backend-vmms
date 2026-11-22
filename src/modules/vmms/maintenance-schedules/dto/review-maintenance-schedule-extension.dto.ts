import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class ReviewMaintenanceScheduleExtensionDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
