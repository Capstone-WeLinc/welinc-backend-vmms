import { IsString, IsOptional } from 'class-validator';
import { UserRole } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  name: string;

  @IsString()
  email: string;

  @IsString()
  passwordHash: string;

  @IsOptional()
  role?: UserRole | string;
}

