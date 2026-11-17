import {
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateMaintenanceLogDto {
  @IsOptional()
  @IsIn(['REPAIR', 'PREVENTIVE'])
  maintenanceClass?: 'REPAIR' | 'PREVENTIVE';

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  maintenanceRemarks?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  serviceOdometerReading?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  laborCost?: number;

  @IsOptional()
  @IsObject()
  partDetails?: Record<string, unknown>;
}
