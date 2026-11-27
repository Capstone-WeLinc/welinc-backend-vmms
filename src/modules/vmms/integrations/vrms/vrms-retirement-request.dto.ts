import {
  IsDateString,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class VrmsRetirementRequestDto {
  @IsUUID()
  eventId!: string;

  @IsUUID()
  requestId!: string;

  @IsUUID()
  vmmsVehicleId!: string;

  @IsUUID()
  repairTicketId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  repairTicketNumber!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;

  @IsDateString()
  occurredAt!: string;
}
