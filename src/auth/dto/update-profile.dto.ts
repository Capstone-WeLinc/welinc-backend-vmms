import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const number = value.trim().replace(/[\s()-]/g, '');
    if (!number) return null;
    if (/^09\d{9}$/.test(number)) return `+63${number.slice(1)}`;
    if (/^639\d{9}$/.test(number)) return `+${number}`;
    return number;
  })
  @Matches(/^\+639\d{9}$/, { message: 'Enter a Philippine mobile number: +63 followed by 10 digits starting with 9 (for example, +639171234567).' })
  contact?: string;
}
