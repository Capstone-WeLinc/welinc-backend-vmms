import { ArrayMaxSize, IsArray } from 'class-validator';

export class SaveOdometerImportDto {
  @IsArray()
  @ArrayMaxSize(1000)
  rows!: unknown[];
}
