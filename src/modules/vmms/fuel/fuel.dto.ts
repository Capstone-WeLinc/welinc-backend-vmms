import { IsBoolean, IsDateString, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class FuelFillUpDto {
  @IsUUID() vehicleId!: string;
  @IsUUID() stationId!: string;
  @IsDateString() date!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) liters!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) pricePerLiter!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) odometer!: number;
  @IsBoolean() isFullTank!: boolean;
  @IsString() @MinLength(1) filledBy!: string;
}

export class VoidFuelDto { @IsString() @MinLength(1) reason!: string; }
export class FuelAnomalyNoteDto { @IsOptional() @IsString() note?: string; }
export class FuelAcknowledgmentDto { @IsOptional() @IsString() remark?: string; }
export class FuelStationDto { @IsString() @MinLength(1) name!: string; }
export class FuelExportDto { @IsString() @MinLength(1) format!: string; @IsOptional() @IsString() from?: string; @IsOptional() @IsString() to?: string; }
export class UpdateFuelAnomalyThresholdDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(99) thresholdPercent!: number;
}
