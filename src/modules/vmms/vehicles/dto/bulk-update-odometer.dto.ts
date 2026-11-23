import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class BulkUpdateOdometerItemDto {
  @IsUUID()
  vehicleId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  odometer!: number;
}

export class BulkUpdateOdometerDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => BulkUpdateOdometerItemDto)
  items!: BulkUpdateOdometerItemDto[];
}