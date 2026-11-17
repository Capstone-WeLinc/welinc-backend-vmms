import { Global, Module } from '@nestjs/common';
import { AuthVerifyModule } from './verify/verify.module';
import { AccountCheck } from './account-check';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';

@Global()
@Module({
  imports: [AuthVerifyModule],
  providers: [AccountCheck, JwtAuthGuard, RolesGuard],
  exports: [AccountCheck, JwtAuthGuard, RolesGuard],
})
export default class AuthModule {}
