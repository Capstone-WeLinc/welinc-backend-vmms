import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import { JwtStrategy } from '../../../auth/strategies/jwt.strategy';
import { PrismaService } from '../../../shared/prisma.service';
import { MaintenanceSchedulesController } from './maintenance-schedules.controller';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

type Role = { role: UserRole; system: SystemType };
const vmms = (role: UserRole): Role => ({ role, system: SystemType.VMMS });

describe('scheduling HTTP permissions', () => {
  let app: INestApplication;
  const secret = 'schedule-permissions-test-only';
  const jwt = new JwtService({ secret });
  const prisma = { user: { findFirst: jest.fn() } };
  const service = { create: jest.fn(), update: jest.fn(), cancel: jest.fn(), findAll: jest.fn(), updateProgress: jest.fn() };
  const writes: ['post' | 'put', string, 'create' | 'update' | 'cancel'][] = [
    ['post', '/maintenance-schedules', 'create'],
    ['put', '/maintenance-schedules/schedule-1', 'update'],
    ['post', '/maintenance-schedules/00000000-0000-4000-8000-000000000001/cancel', 'cancel'],
  ];
  const setUser = (roles: Role[]) => prisma.user.findFirst.mockResolvedValue({
    id: 'user-1', email: 'test@example.invalid', isActive: true, lockedAt: null, roles,
  });
  const token = (roles: Role[], system: SystemType = SystemType.VMMS) => jwt.sign({ sub: 'user-1', roles, system });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MaintenanceSchedulesController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { getOrThrow: () => secret } },
        { provide: PrismaService, useValue: prisma },
        { provide: MaintenanceSchedulesService, useValue: service },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    setUser([vmms(UserRole.OPERATIONS)]);
    for (const method of Object.values(service)) method.mockResolvedValue({ ok: true });
  });
  afterAll(async () => { await app?.close(); });

  it.each(writes)('rejects anonymous %s %s', async (method, path, handler) => {
    await request(app.getHttpServer())[method](path).expect(401);
    expect(service[handler]).not.toHaveBeenCalled();
  });
  it.each(writes)('allows Operations %s %s', async (method, path, handler) => {
    const body = { vehicleId: 'ABC123', title: 'PMS', assignedMechanicId: 'mechanic-1', chiefMechanicId: 'chief-1' };
    await request(app.getHttpServer())[method](path)
      .set('Authorization', `Bearer ${token([vmms(UserRole.OPERATIONS)])}`).send(body)
      .expect(method === 'post' ? 201 : 200);
    expect(service[handler]).toHaveBeenCalledTimes(1);
  });
  describe.each([UserRole.ADMIN, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC])('%s scheduling writes', (role) => {
    it.each(writes)('denies %s %s', async (method, path, handler) => {
      setUser([vmms(role)]);
      await request(app.getHttpServer())[method](path)
        .set('Authorization', `Bearer ${token([vmms(role)])}`)
        .send({ assignedMechanicId: 'replacement', chiefMechanicId: 'replacement-chief' }).expect(403);
      expect(service[handler]).not.toHaveBeenCalled();
    });
  });
  describe.each([SystemType.VRMS, SystemType.BMS])('%s Operations is insufficient', (system) => {
    it.each(writes)('denies %s %s despite foreign system claims', async (method, path, handler) => {
      const roles = [vmms(UserRole.ADMIN), { role: UserRole.OPERATIONS, system }];
      setUser(roles);
      await request(app.getHttpServer())[method](`${path}?system=${system}`)
        .set('Authorization', `Bearer ${token(roles, system)}`)
        .set('Origin', `https://${system.toLowerCase()}.example.invalid`)
        .send({ roleAssignments: [{ role: UserRole.OPERATIONS, system }] }).expect(403);
      expect(service[handler]).not.toHaveBeenCalled();
    });
  });
  it.each([UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC])(
    'preserves scoped read requests for %s', async (role) => {
      setUser([vmms(role)]);
      await request(app.getHttpServer()).get('/maintenance-schedules')
        .set('Authorization', `Bearer ${token([vmms(role)])}`).expect(200);
      expect(service.findAll).toHaveBeenCalledWith(expect.objectContaining({ sub: 'user-1', roles: [vmms(role)] }));
    },
  );
  it.each([UserRole.MECHANIC, UserRole.CHIEF_MECHANIC])('preserves the %s execution/review endpoint', async (role) => {
    setUser([vmms(role)]);
    await request(app.getHttpServer()).patch('/maintenance-schedules/schedule-1/progress')
      .set('Authorization', `Bearer ${token([vmms(role)])}`).send({ action: role === UserRole.MECHANIC ? 'SUBMIT' : 'APPROVE' }).expect(200);
    expect(service.updateProgress).toHaveBeenCalledWith('schedule-1', expect.any(Object), expect.objectContaining({ roles: [vmms(role)] }));
  });
});

describe('assignments cannot be changed through work-order progress', () => {
  const actor = { sub: 'mechanic-1', system: 'VMMS', roles: [{ role: 'MECHANIC', system: 'VMMS' }] };
  const schedule = {
    id: 'schedule-1', vehicleId: 'ABC123', status: 'IN_PROGRESS',
    assignedMechanicId: actor.sub, assignedMechanic: 'Mechanic One',
    chiefMechanicId: 'chief-1', chiefMechanic: 'Chief One', workOrderProgress: {},
  };
  const prisma = {
    maintenanceSchedule: { findFirst: jest.fn(), update: jest.fn() },
    vehicle: { findFirst: jest.fn() }, $transaction: jest.fn(),
  };
  let service: MaintenanceSchedulesService;
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.maintenanceSchedule.findFirst.mockResolvedValue(schedule);
    prisma.maintenanceSchedule.update.mockImplementation(async ({ data }) => ({ ...schedule, ...data }));
    prisma.vehicle.findFirst.mockResolvedValue({ id: 'vehicle-1', status: 'UNDER_MAINTENANCE' });
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    service = new MaintenanceSchedulesService(prisma as unknown as PrismaService);
  });
  it.each(['chiefMechanic', 'chiefMechanicId', 'chief_mechanic', 'chief_mechanic_id', 'assignedMechanicId', 'assignedMechanic', 'assignedDriver'])(
    'blocks attempts to change %s at top level or in nested progress', async (field) => {
      for (const payload of [{ action: 'SAVE', [field]: 'replacement' }, { action: 'SAVE', workOrderProgress: { [field]: 'replacement' } }]) {
        await expect(service.updateProgress(schedule.id, payload, actor)).rejects.toThrow('Only Operations');
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
    },
  );
  it.each(['', 'Chief One'])('preserves the assigned inspector when mobile submits display name %p', async (name) => {
    await service.updateProgress(schedule.id, { action: 'SAVE', chiefMechanic: name, executionItems: [] }, actor);
    const data = prisma.maintenanceSchedule.update.mock.calls[0][0].data;
    expect(data.chiefMechanicId).toBeUndefined();
    expect(data.assignedMechanicId).toBeUndefined();
    expect(data.workOrderProgress.chiefMechanic).toBe('Chief One');
  });
});
