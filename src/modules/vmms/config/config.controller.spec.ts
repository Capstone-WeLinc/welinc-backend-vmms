import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { VmmsConfigController } from './config.controller';
import { VmmsConfigService } from './config.service';

describe('VmmsConfigController outsourced providers', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'outsourced-provider-test-secret' });
  const service = {
    listOutsourcedProviders: jest.fn(),
    createOutsourcedProvider: jest.fn(),
    updateOutsourcedProvider: jest.fn(),
    deleteOutsourcedProvider: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [VmmsConfigController],
      providers: [{ provide: VmmsConfigService, useValue: service }],
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
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: () => true,
      })
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => app?.close());

  const token = (role: UserRole) =>
    jwt.sign({
      sub: 'user-id',
      roles: [{ role, system: SystemType.VMMS }],
      system: SystemType.VMMS,
    });

  it('allows Admin to list providers', async () => {
    service.listOutsourcedProviders.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get('/config/outsourced-providers')
      .set('Authorization', `Bearer ${token(UserRole.ADMIN)}`)
      .expect(200);
  });

  it('rejects invalid mutation DTO values', async () => {
    await request(app.getHttpServer())
      .post('/config/outsourced-providers')
      .set('Authorization', `Bearer ${token(UserRole.OPERATIONS)}`)
      .send({ name: 'x'.repeat(151) })
      .expect(400);

    await request(app.getHttpServer())
      .patch('/config/outsourced-providers/00000000-0000-4000-8000-000000000001')
      .set('Authorization', `Bearer ${token(UserRole.OPERATIONS)}`)
      .send({ isActive: 'yes' })
      .expect(400);

    expect(service.createOutsourcedProvider).not.toHaveBeenCalled();
    expect(service.updateOutsourcedProvider).not.toHaveBeenCalled();
  });
});
