import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class VrmsRepeatRepairAlertDto {
  @IsUUID()
  eventId!: string;

  @IsUUID()
  vmmsVehicleId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  category!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(32, { each: true })
  repairTicketNumbers!: string[];

  @IsInt()
  @Min(1)
  @Max(3650)
  windowDays!: number;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  count!: number;

  @IsDateString()
  occurredAt!: string;
}
