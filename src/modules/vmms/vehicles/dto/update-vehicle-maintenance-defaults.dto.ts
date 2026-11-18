import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

export class VehicleMaintenanceDefaultOverrideDto {
  @IsUUID()
  checklistTemplateId!: string;

  @IsString()
  @Matches(/^\d+$/)
  intervalKm!: string;

  @IsString()
  @Matches(/^\d+$/)
  bufferDistanceKm!: string;
}

export class UpdateVehicleMaintenanceDefaultsDto {
  @IsString()
  @Matches(/^\d*$/)
  baseIntervalKm!: string;

  @IsString()
  @Matches(/^\d*$/)
  baseBufferDistanceKm!: string;

  @IsArray()
  @ArrayUnique((override: VehicleMaintenanceDefaultOverrideDto) =>
    override.checklistTemplateId.toLowerCase(),
  )
  @ValidateNested({ each: true })
  @Type(() => VehicleMaintenanceDefaultOverrideDto)
  categoryOverrides!: VehicleMaintenanceDefaultOverrideDto[];
}
