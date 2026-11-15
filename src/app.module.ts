import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnv } from './config/env';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import SharedModule from './shared/shared.module';
import AuthModule from './auth/auth.module';
import { VmmsModule } from './modules/vmms/vmms.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SessionModule } from './session/session.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    SharedModule,
    AuthModule,
    VmmsModule,
    NotificationsModule,
    SessionModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
