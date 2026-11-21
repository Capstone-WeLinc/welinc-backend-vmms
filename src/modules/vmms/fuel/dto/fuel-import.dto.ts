import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SaveFuelImportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  rows!: unknown[];
}

export class FuelImportDraftDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  sourceName!: string;

  @IsArray()
  @ArrayMaxSize(1000)
  rows!: unknown[];
}
