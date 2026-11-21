import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

function multipartBoolean(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export class FuelFillUpDto {
  @IsUUID() vehicleId!: string;
  @IsUUID() stationId!: string;
  @IsDateString() date!: string;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  liters!: number;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  pricePerLiter!: number;
  @IsOptional() @IsString() @MaxLength(100) poNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) siNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) product?: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) odometer!: number;
  @Transform(({ value }) => multipartBoolean(value))
  @IsBoolean()
  isFullTank!: boolean;
  @IsString() @MinLength(1) filledBy!: string;
}

export class VoidFuelDto {
  @IsString() @MinLength(1) reason!: string;
}
export class FuelAnomalyNoteDto {
  @IsOptional() @IsString() note?: string;
}
export class FuelAcknowledgmentDto {
  @IsOptional() @IsString() remark?: string;
}
export class FuelStationDto {
  @IsString() @MinLength(1) name!: string;
}
export class UpdateFuelStationDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
export class FuelExportDto {
  @IsString() @MinLength(1) format!: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}
export class UpdateFuelAnomalyThresholdDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(99)
  thresholdPercent!: number;
}
