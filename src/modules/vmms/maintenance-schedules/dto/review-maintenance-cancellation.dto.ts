import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewMaintenanceCancellationDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
