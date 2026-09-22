import { IsString, Matches } from 'class-validator';

const internationalPhonePattern = /^(?:\+639\d{9}|\+(?!63)\d{7,14})$/;

export class SendPhoneVerificationDto {
  @IsString()
  @Matches(internationalPhonePattern, {
    message: 'Phone must be a valid international phone number with country code.',
  })
  phone!: string;
}

export class VerifyPhoneDto {
  @IsString()
  @Matches(internationalPhonePattern, {
    message: 'Phone must be a valid international phone number with country code.',
  })
  phone!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'Verification code must be 6 digits.' })
  code!: string;
}