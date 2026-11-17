import { HttpException } from '@nestjs/common';
import { HealthController } from './health.controller';
import type { PrismaService } from '../shared/prisma.service';

const controllerWith = (queryRaw: () => Promise<unknown>) =>
  new HealthController({ $queryRaw: queryRaw } as unknown as PrismaService);

describe('HealthController', () => {
  it('answers ok when the database query succeeds', async () => {
    await expect(
      controllerWith(() => Promise.resolve([])).health(),
    ).resolves.toEqual({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('answers 503 when the database query fails', async () => {
    const controller = controllerWith(() =>
      Promise.reject(new Error('connection refused')),
    );
    const error = await controller
      .health()
      .catch((value: unknown) => value as HttpException);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({
      code: 'HEALTH_CHECK_FAILED',
      checks: { database: 'failed' },
    });
    expect(JSON.stringify(error.getResponse())).not.toContain('refused');
  });
});
