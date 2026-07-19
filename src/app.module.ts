import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import SharedModule from './shared/shared.module';
import AuthModule from './auth/auth.module';
import { VmmsModule } from './modules/vmms/vmms.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SharedModule,
    AuthModule,
    VmmsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
