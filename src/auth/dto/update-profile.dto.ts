import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';

const internationalPhonePattern = /^(?:\+639\d{9}|\+(?!63)\d{7,14})$/;

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsString()
  @Matches(internationalPhonePattern, {
    message: 'Contact must be a valid international phone number with country code.',
  })
  contact?: string;
}
