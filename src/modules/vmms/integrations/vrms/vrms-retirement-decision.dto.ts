import { VrmsRetirementDecision } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class VrmsRetirementDecisionDto {
  @IsEnum(VrmsRetirementDecision)
  decision!: VrmsRetirementDecision;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
