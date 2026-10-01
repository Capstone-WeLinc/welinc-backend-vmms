import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import { JwtStrategy } from '../../../auth/strategies/jwt.strategy';
import { PrismaService } from '../../../shared/prisma.service';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

type Role = { role: UserRole; system: SystemType };
const secret = 'vehicle-permissions-test-only';
const vehicleId = '8da72728-b06e-4475-945e-2cf3c99a996e';
const roleFor = (role: UserRole): Role => ({ role, system: SystemType.VMMS });

describe('vehicle HTTP permissions', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret });
  const prisma = { user: { findFirst: jest.fn() } };
  const service = { create: jest.fn(), update: jest.fn(), delete: jest.fn(), findAll: jest.fn(), findAuditHistory: jest.fn() };
  const writes: ['post' | 'patch' | 'delete', string, keyof typeof service][] = [
    ['post', '/vehicles', 'create'],
    ['patch', `/vehicles/${vehicleId}`, 'update'],
    ['delete', `/vehicles/${vehicleId}`, 'delete'],
  ];
  const token = (roles: Role[], system: SystemType = SystemType.VMMS) => jwt.sign({ sub: 'user-id', roles, system });
  const setUser = (roles: Role[]) => prisma.user.findFirst.mockResolvedValue({
    id: 'user-id', email: 'test@example.invalid', isActive: true, lockedAt: null, roles,
  });
  const expectNoWrites = () => {
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [VehiclesController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { getOrThrow: () => secret } },
        { provide: PrismaService, useValue: prisma },
        { provide: VehiclesService, useValue: service },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    setUser([roleFor(UserRole.OPERATIONS)]);
    for (const method of Object.values(service)) method.mockResolvedValue({ ok: true });
  });
  afterAll(async () => { await app?.close(); });

  it.each(writes)('rejects anonymous %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
    expectNoWrites();
  });

  it.each(writes)('allows Operations %s %s', async (method, path, handler) => {
    await request(app.getHttpServer())[method](path)
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .send({
        plateNumber: 'ABC123',
        make: 'Isuzu',
        model: 'Truck',
        year: 2022,
        engineType: 'Diesel',
        truckSizeCategory: 'Medium Duty',
        odometer: 100,
        garageId: '8da72728-b06e-4475-945e-2cf3c99a996e',
      }).expect(method === 'post' ? 201 : 200);
    expect(service[handler]).toHaveBeenCalledTimes(1);
  });

  it('passes the authenticated editor identity to the vehicle update service', async () => {
    await request(app.getHttpServer()).patch(`/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .send({ make: 'Hino' }).expect(200);

    expect(service.update).toHaveBeenCalledWith(vehicleId, { make: 'Hino' }, {
      sub: 'user-id',
      email: 'test@example.invalid',
      roles: [roleFor(UserRole.OPERATIONS)],
      system: SystemType.VMMS,
    });
  });

  describe.each([UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC])('%s cannot manage vehicles', (role) => {
    it.each(writes)('denies %s %s', async (method, path) => {
      setUser([roleFor(role)]);
      await request(app.getHttpServer())[method](path)
        .set('Authorization', `Bearer ${token([roleFor(role)])}`).send({ isActive: false }).expect(403);
      expectNoWrites();
    });
  });

  it.each([UserRole.ADMIN, UserRole.OPERATIONS, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC])(
    'preserves vehicle reads for %s', async (role) => {
      setUser([roleFor(role)]);
      const readRequest = request(app.getHttpServer()).get('/vehicles')
        .set('Authorization', `Bearer ${token([roleFor(role)])}`);
      if (role === UserRole.MECHANIC || role === UserRole.CHIEF_MECHANIC) {
        readRequest.set('X-VMMS-Client', 'mobile');
      }
      await readRequest.expect(200);
      expect(service.findAll).toHaveBeenCalledTimes(1);
    },
  );

  it.each([UserRole.ADMIN, UserRole.OPERATIONS])('allows %s to read vehicle audit history', async (role) => {
    setUser([roleFor(role)]);
    await request(app.getHttpServer()).get(`/vehicles/${vehicleId}/audit`)
      .set('Authorization', `Bearer ${token([roleFor(role)])}`).expect(200);
    expect(service.findAuditHistory).toHaveBeenCalledWith(vehicleId);
  });

  it.each([UserRole.MECHANIC, UserRole.CHIEF_MECHANIC])('denies %s access to vehicle audit history', async (role) => {
    setUser([roleFor(role)]);
    await request(app.getHttpServer()).get(`/vehicles/${vehicleId}/audit`)
      .set('Authorization', `Bearer ${token([roleFor(role)])}`)
      .set('X-VMMS-Client', 'mobile').expect(403);
    expect(service.findAuditHistory).not.toHaveBeenCalled();
  });

  describe.each([SystemType.VRMS, SystemType.BMS])('%s cannot grant VMMS mutation access', (system) => {
    it.each(writes)('denies %s %s despite spoofed subsystem context', async (method, path) => {
      const roles = [roleFor(UserRole.ADMIN), { role: UserRole.OPERATIONS, system }];
      setUser(roles);
      await request(app.getHttpServer())[method](`${path}?system=${system}`)
        .set('Authorization', `Bearer ${token(roles, system)}`)
        .set('Origin', `https://${system.toLowerCase()}.example.invalid`)
        .send({ roleAssignments: [{ role: UserRole.OPERATIONS, system }] }).expect(403);
      expectNoWrites();
    });
  });

  it('uses current roles after Operations is reassigned to Admin', async () => {
    const operationsToken = token([roleFor(UserRole.OPERATIONS)]);
    setUser([roleFor(UserRole.ADMIN)]);
    await request(app.getHttpServer()).patch(`/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${operationsToken}`).send({ isActive: false }).expect(403);
    expectNoWrites();
  });

  it('rejects deactivated Operations accounts', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-id', isActive: false, lockedAt: null, roles: [roleFor(UserRole.OPERATIONS)] });
    await request(app.getHttpServer()).post('/vehicles')
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`).send({}).expect(401);
    expectNoWrites();
  });
});
