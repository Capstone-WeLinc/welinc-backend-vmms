import { Module } from '@nestjs/common';
import { AuthClient } from './auth-client';
import { SessionCsrfGuard } from './csrf.guard';
import { SessionController } from './session.controller';
import { sessionConfigProvider } from './session.config';
import AuthModule from '../auth/auth.module';

/**
 * The VMMS session routes (spec 0003): login start and callback, refresh and status, with the
 * refresh cookie and the CSRF guard. The reference module other groups copy (S11).
 */
@Module({
  imports: [AuthModule],
  providers: [sessionConfigProvider, AuthClient, SessionCsrfGuard],
  controllers: [SessionController],
})
export class SessionModule {}
