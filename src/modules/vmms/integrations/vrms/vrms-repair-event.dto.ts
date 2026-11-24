import { VrmsRepairEventType } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

const repairStatuses = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
  'OUTSOURCED',
  'FOR_VERIFICATION',
  'CLOSED',
  'CANCELLED',
] as const;

export class VrmsRepairEventDto {
  @IsUUID()
  eventId!: string;

  @IsUUID()
  repairTicketId!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  eventVersion!: number;

  @IsEnum(VrmsRepairEventType)
  eventType!: VrmsRepairEventType;

  @IsUUID()
  vmmsVehicleId!: string;

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  maintenanceScheduleIds!: string[];

  @IsDateString()
  occurredAt!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  serviceOdometerReading?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  repairTicketNumber?: string;

  @IsOptional()
  @IsString()
  @IsIn(repairStatuses)
  repairStatus?: (typeof repairStatuses)[number];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  outsideShopName?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  acceptedReferralIds?: string[];
}
