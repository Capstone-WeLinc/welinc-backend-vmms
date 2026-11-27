import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const notificationCategories = [
  'MAINTENANCE',
  'FUEL',
  'REPORT',
  'GENERAL',
] as const;
export type NotificationCategory = (typeof notificationCategories)[number];

export const notificationReadStates = ['ALL', 'UNREAD', 'READ'] as const;
export type NotificationReadState = (typeof notificationReadStates)[number];

export class NotificationsInboxQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 30;

  @IsOptional()
  @IsIn(notificationCategories)
  category?: NotificationCategory;

  @IsOptional()
  @IsIn(notificationReadStates)
  readState: NotificationReadState = 'ALL';
}
