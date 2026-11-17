import {
  AccountType,
  MaintenanceIntervalType,
  MaintenanceStatus,
  MaintenancePriority,
  MaintenanceTriggerType,
} from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMaintenanceScheduleDto {
  @IsEnum(MaintenancePriority)
  @IsOptional()
  priority?: MaintenancePriority;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  timeIntervalValue?: number;

  @IsOptional()
  @IsIn(['DAYS', 'MONTHS'])
  timeIntervalUnit?: 'DAYS' | 'MONTHS';

  // Create requires this in the service; edits may retain the stored date.
  @IsString()
  @IsOptional()
  startDate?: string;

  @IsString()
  @IsOptional()
  targetDueDate?: string;

  @IsString()
  @IsNotEmpty()
  vehicleId!: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsOptional()
  assignedMechanic?: string;

  @IsString()
  @IsOptional()
  assignedMechanicId?: string;

  @IsString()
  @IsOptional()
  assignedDriver?: string;

  @IsString()
  @IsOptional()
  chiefMechanicId?: string;

  @IsString()
  @IsOptional()
  chief_mechanic_id?: string;

  @IsString()
  @IsOptional()
  chiefMechanic?: string;

  @IsString()
  @IsOptional()
  chief_mechanic?: string;

  @IsEnum(MaintenanceStatus)
  @IsOptional()
  status?: MaintenanceStatus;

  @IsString()
  @IsOptional()
  garageId?: string;

  @IsEnum(AccountType)
  @IsOptional()
  accountType?: AccountType;

  @IsEnum(AccountType)
  @IsOptional()
  account_type?: AccountType;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  outsourcedProvider?: string;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  partsCost?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  parts_cost?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  laborCost?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  labor_cost?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  totalCost?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  total_cost?: number;

  @IsString()
  @IsOptional()
  odometerReading?: string;

  @IsEnum(MaintenanceTriggerType)
  @IsOptional()
  triggerType?: MaintenanceTriggerType;

  @IsString()
  @IsOptional()
  intervalKm?: string;

  @IsString()
  @IsOptional()
  bufferDistanceKm?: string;

  @IsString()
  @IsOptional()
  startingReferenceReadingKm?: string;

  @IsEnum(MaintenanceIntervalType)
  @IsOptional()
  intervalType?: MaintenanceIntervalType;

  @IsString()
  @IsOptional()
  startReferenceDate?: string;

  @IsUUID()
  @IsOptional()
  checklistTemplateId?: string;

  @IsOptional()
  workOrderProgress?: unknown;

  @IsOptional()
  work_order_progress?: unknown;
}
