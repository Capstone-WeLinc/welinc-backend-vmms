import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

describe('VehiclesController bulk odometer endpoint', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'bulk-odometer-test-secret' });
  const service = {
    bulkUpdateOdometer: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [VehiclesController],
      providers: [{ provide: VehiclesService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const auth = ctx.switchToHttp().getRequest().headers.authorization ?? '';
          if (!auth.startsWith('Bearer ')) throw new UnauthorizedException();
          ctx.switchToHttp().getRequest().user = jwt.verify(auth.slice(7));
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true,
      }),
    );
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service.bulkUpdateOdometer.mockResolvedValue({
      updated: 1,
      unchanged: 0,
      failed: 0,
      results: [],
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts a JSON bulk odometer update for Operations', async () => {
    const token = jwt.sign({
      sub: 'user-id',
      email: 'ops@example.invalid',
      roles: [{ role: UserRole.OPERATIONS, system: SystemType.VMMS }],
      system: SystemType.VMMS,
    });

    await request(app.getHttpServer())
      .post('/vehicles/odometer/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            vehicleId: '8da72728-b06e-4475-945e-2cf3c99a996e',
            odometer: 1200,
          },
        ],
      })
      .expect(201);

    expect(service.bulkUpdateOdometer).toHaveBeenCalledWith(
      [{ vehicleId: '8da72728-b06e-4475-945e-2cf3c99a996e', odometer: 1200 }],
      expect.objectContaining({ sub: 'user-id' }),
    );
  });

  it('rejects invalid bulk payloads', async () => {
    const token = jwt.sign({
      sub: 'user-id',
      email: 'ops@example.invalid',
      roles: [{ role: UserRole.OPERATIONS, system: SystemType.VMMS }],
      system: SystemType.VMMS,
    });

    await request(app.getHttpServer())
      .post('/vehicles/odometer/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [] })
      .expect(400);

    expect(service.bulkUpdateOdometer).not.toHaveBeenCalled();
  });
});
