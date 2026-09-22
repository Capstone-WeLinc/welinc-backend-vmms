import { IsString, Matches } from 'class-validator';

const strongPasswordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @Matches(strongPasswordPattern, {
    message:
      'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character.',
  })
  newPassword!: string;

  @IsString()
  @Matches(strongPasswordPattern, {
    message:
      'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character.',
  })
  confirmPassword!: string;
}
