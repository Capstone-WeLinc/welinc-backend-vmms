import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { UnauthorizedException } from '@nestjs/common';
import { MaintenanceCostingController } from './maintenance-costing.controller';
import { MaintenanceCostingService } from './maintenance-costing.service';

type Role = { role: UserRole; system: SystemType };
const vmmsRole = (role: UserRole): Role => ({ role, system: SystemType.VMMS });

describe('MaintenanceCostingController role access', () => {
  let app: INestApplication;
  const secret = 'maintenance-costing-access-test-only';
  const jwt = new JwtService({ secret });
  const service = { getDashboard: jest.fn(), updateThreshold: jest.fn() };
  const token = (roles: Role[], system: SystemType = SystemType.VMMS) =>
    jwt.sign({ sub: 'user-1', email: 'test@example.invalid', roles, system });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MaintenanceCostingController],
      providers: [        { provide: MaintenanceCostingService, useValue: service },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (ctx: any) => { const auth = ctx.switchToHttp().getRequest().headers.authorization ?? ''; if (!auth.startsWith('Bearer ')) throw new UnauthorizedException(); try { ctx.switchToHttp().getRequest().user = jwt.verify(auth.slice(7)); return true; } catch { throw new UnauthorizedException(); } } }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service.getDashboard.mockResolvedValue({ totalMaintenanceCosts: 0 });
    service.updateThreshold.mockResolvedValue({ threshold: 50000 });
  });

  afterAll(async () => { await app?.close(); });

  it.each([UserRole.ADMIN, UserRole.OPERATIONS])('allows %s to read costing aggregates', async (role) => {
    await request(app.getHttpServer())
      .get('/maintenance-costing?from=2026-06-01&to=2026-06-30')
      .set('Authorization', `Bearer ${token([vmmsRole(role)])}`)
      .expect(200);
    expect(service.getDashboard).toHaveBeenCalledWith('2026-06-01', '2026-06-30');
  });

  it.each([UserRole.CHIEF_MECHANIC, UserRole.MECHANIC])('denies web costing access to %s', async (role) => {
    await request(app.getHttpServer())
      .get('/maintenance-costing')
      .set('Authorization', `Bearer ${token([vmmsRole(role)])}`)
      .expect(403);
    expect(service.getDashboard).not.toHaveBeenCalled();
  });

  it('allows only Admin to configure a positive threshold', async () => {
    await request(app.getHttpServer())
      .patch('/maintenance-costing/threshold')
      .set('Authorization', `Bearer ${token([vmmsRole(UserRole.ADMIN)])}`)
      .send({ threshold: 50000 })
      .expect(200);
    expect(service.updateThreshold).toHaveBeenCalledWith(50000, expect.objectContaining({ sub: 'user-1' }));

    jest.clearAllMocks();
    await request(app.getHttpServer())
      .patch('/maintenance-costing/threshold')
      .set('Authorization', `Bearer ${token([vmmsRole(UserRole.OPERATIONS)])}`)
      .send({ threshold: 50000 })
      .expect(403);
    expect(service.updateThreshold).not.toHaveBeenCalled();
  });

  it('rejects non-positive or extra threshold fields', async () => {
    for (const body of [{ threshold: 0 }, { threshold: 10, income: 1 }]) {
      await request(app.getHttpServer())
        .patch('/maintenance-costing/threshold')
        .set('Authorization', `Bearer ${token([vmmsRole(UserRole.ADMIN)])}`)
        .send(body)
        .expect(400);
    }
    expect(service.updateThreshold).not.toHaveBeenCalled();
  });
});
