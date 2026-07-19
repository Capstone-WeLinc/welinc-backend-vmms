import {
  AccountType,
  MaintenanceIntervalType,
  MaintenanceStatus,
  MaintenanceTriggerType,
} from '@prisma/client';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateMaintenanceScheduleDto {
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
  assignedDriver?: string;

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

  @IsString()
  @IsOptional()
  checklistTemplateId?: string;
}
