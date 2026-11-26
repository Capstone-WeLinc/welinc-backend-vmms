import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../auth/guards/roles.guard';
import { VrmsRepairReferralsController } from './vrms-repair-referrals.controller';
import { VrmsRepairReferralsService } from './vrms-repair-referrals.service';

describe('VRMS repair referral retry authorization', () => {
  let app: INestApplication;
  const referralId = 'c4b5a2e8-59c4-4c18-8bda-97e8df63f1c0';
  const actor: {
    sub: string;
    email: string;
    roles: { role: UserRole; system: SystemType }[];
    system: SystemType;
  } = {
    sub: 'admin-user',
    email: 'admin@example.test',
    roles: [{ role: UserRole.ADMIN, system: SystemType.VMMS }],
    system: SystemType.VMMS,
  };
  const referrals = {
    retryFailed: jest.fn().mockResolvedValue({
      id: referralId,
      status: 'SENT',
    }),
  };

  const asRole = (role: UserRole, system = SystemType.VMMS) => {
    actor.roles = [{ role, system }];
    actor.system = system;
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [VrmsRepairReferralsController],
      providers: [
        RolesGuard,
        { provide: VrmsRepairReferralsService, useValue: referrals },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = actor;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('vmms');
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('allows VMMS Admin to retry a referral with its ID', async () => {
    asRole(UserRole.ADMIN);

    await request(app.getHttpServer())
      .post(`/vmms/integrations/vrms/repair-referrals/${referralId}/retry`)
      .expect(201);

    expect(referrals.retryFailed).toHaveBeenCalledWith(referralId);
  });

  it.each([UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC])(
    'denies VMMS %s from retrying a referral',
    async (role) => {
      asRole(role);

      await request(app.getHttpServer())
        .post(`/vmms/integrations/vrms/repair-referrals/${referralId}/retry`)
        .expect(403);

      expect(referrals.retryFailed).not.toHaveBeenCalled();
    },
  );

  it('denies an Admin role assigned to another system', async () => {
    asRole(UserRole.ADMIN, SystemType.VRMS);

    await request(app.getHttpServer())
      .post(`/vmms/integrations/vrms/repair-referrals/${referralId}/retry`)
      .expect(403);

    expect(referrals.retryFailed).not.toHaveBeenCalled();
  });
});
