import { IsBoolean, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class CreateOutsourcedProviderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;
}

export class UpdateOutsourcedProviderDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
