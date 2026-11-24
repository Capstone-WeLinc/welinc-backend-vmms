import { VrmsRepairReferralEventType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class VrmsRepairReferralEventDto {
  @IsUUID()
  eventId!: string;

  @IsUUID()
  referralId!: string;

  @IsEnum(VrmsRepairReferralEventType)
  eventType!: VrmsRepairReferralEventType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  reason!: string;

  @IsDateString()
  occurredAt!: string;
}
