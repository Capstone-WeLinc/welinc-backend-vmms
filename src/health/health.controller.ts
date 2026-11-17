import {
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { Public } from '../auth/permissions/permission.decorators';

const HEALTH_TIMEOUT_MS = 2000;

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  @Header('Cache-Control', 'no-store')
  async health() {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'failed'>((resolve) => {
      timer = setTimeout(() => resolve('failed'), HEALTH_TIMEOUT_MS);
    });
    const databaseCheck = Promise.resolve(this.prisma.$queryRaw`SELECT 1`).then(
      () => 'ok' as const,
      () => 'failed' as const,
    );
    let database: 'ok' | 'failed';
    try {
      database = await Promise.race([databaseCheck, timedOut]);
    } finally {
      clearTimeout(timer);
    }
    const checks = { database };
    if (database !== 'ok') {
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'A health check failed',
          error: 'Service Unavailable',
          code: 'HEALTH_CHECK_FAILED',
          status: 'unavailable',
          checks,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ok', checks };
  }
}
