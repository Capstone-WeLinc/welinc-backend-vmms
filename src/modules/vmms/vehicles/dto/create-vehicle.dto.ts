import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateVehicleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  plateNumber!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  make!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  year!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  engineType!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  truckSizeCategory!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  odometer!: number;

  @IsUUID()
  garageId!: string;
}
