import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import { JwtStrategy } from '../../../auth/strategies/jwt.strategy';
import { PrismaService } from '../../../shared/prisma.service';
import { ChecklistsController } from './checklists.controller';
import { ChecklistsService } from './checklists.service';

type Role = { role: UserRole; system: SystemType };
type Method = 'get' | 'post' | 'patch' | 'delete';
const secret = 'checklist-authorization-test-only';
const vmmsRole = (role: UserRole): Role => ({ role, system: SystemType.VMMS });

describe('checklist HTTP permissions', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret });
  const prisma = { user: { findFirst: jest.fn() } };
  const service = {
    create: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), findByType: jest.fn(),
    update: jest.fn(), updateByType: jest.fn(), remove: jest.fn(),
    removeByType: jest.fn(), upsertMany: jest.fn(),
  };
  const writes: [Method, string, keyof typeof service][] = [
    ['post', '/checklists', 'create'],
    ['patch', '/checklists/template-id', 'update'],
    ['patch', '/checklists/type/PMS', 'updateByType'],
    ['delete', '/checklists/template-id', 'remove'],
    ['delete', '/checklists/type/PMS', 'removeByType'],
    ['post', '/checklists/sync', 'upsertMany'],
  ];
  const reads: [Method, string, keyof typeof service][] = [
    ['get', '/checklists', 'findAll'],
    ['get', '/checklists/template-id', 'findOne'],
    ['get', '/checklists/type/PMS', 'findByType'],
  ];
  const token = (roles: Role[], system: SystemType = SystemType.VMMS) =>
    jwt.sign({ sub: 'user-id', email: 'test@example.invalid', roles, system });
  const setUser = (roles: Role[]) => prisma.user.findFirst.mockResolvedValue({
    id: 'user-id', email: 'test@example.invalid', isActive: true, lockedAt: null, roles,
  });
  const expectNoServiceCalls = () => {
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ChecklistsController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { getOrThrow: () => secret } },
        { provide: PrismaService, useValue: prisma },
        { provide: ChecklistsService, useValue: service },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    setUser([vmmsRole(UserRole.ADMIN)]);
    for (const method of Object.values(service)) method.mockResolvedValue({ ok: true });
  });
  afterAll(async () => { await app?.close(); });

  it.each([...writes, ...reads])('rejects unauthenticated %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
    expectNoServiceCalls();
  });

  it.each(writes)('allows VMMS Admin %s %s', async (method, path, handler) => {
    await request(app.getHttpServer())[method](path)
      .set('Authorization', `Bearer ${token([vmmsRole(UserRole.ADMIN)])}`)
      .send({ type: 'PMS', items: [] }).expect(method === 'post' ? 201 : 200);
    expect(service[handler]).toHaveBeenCalledTimes(1);
  });

  describe.each([UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC])('%s writes', (role) => {
    it.each(writes)('denies %s %s without modifying templates', async (method, path) => {
      setUser([vmmsRole(role)]);
      await request(app.getHttpServer())[method](path)
        .set('Authorization', `Bearer ${token([vmmsRole(role)])}`)
        .send({ type: 'PMS', items: [] }).expect(403);
      expectNoServiceCalls();
    });
  });

  describe.each([UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC])('%s reads', (role) => {
    it.each(reads)('preserves %s %s', async (method, path, handler) => {
      setUser([vmmsRole(role)]);
      const req = request(app.getHttpServer())[method](path)
        .set('Authorization', `Bearer ${token([vmmsRole(role)])}`).expect(200);
      await req;
      expect(service[handler]).toHaveBeenCalledTimes(1);
    });
  });

  it.each([UserRole.CHIEF_MECHANIC, UserRole.MECHANIC])(
    'rejects %s checklist reads from the web client',
    async (role) => {
      setUser([vmmsRole(role)]);
      await request(app.getHttpServer()).get('/checklists')
        .set('Authorization', `Bearer ${token([vmmsRole(role)])}`)
        .expect(403);
      expectNoServiceCalls();
    },
  );

  describe.each([SystemType.VRMS, SystemType.BMS])('%s Admin cannot substitute for VMMS Admin', (system) => {
    it.each(writes)('denies %s %s with another subsystem token and spoofed context', async (method, path) => {
      const roles = [vmmsRole(UserRole.MECHANIC), { role: UserRole.ADMIN, system }];
      setUser(roles);
      await request(app.getHttpServer())[method](`${path}?system=${system}`)
        .set('Authorization', `Bearer ${token(roles, system)}`)
        .set('Origin', `https://${system.toLowerCase()}.example.invalid`)
        .set('Referer', `https://${system.toLowerCase()}.example.invalid`)
        .send({ roleAssignments: [{ role: UserRole.ADMIN, system }] }).expect(403);
      expectNoServiceCalls();
    });

    it('denies template reads to users without any VMMS role', async () => {
      const roles = [{ role: UserRole.ADMIN, system }];
      setUser(roles);
      await request(app.getHttpServer()).get('/checklists')
        .set('Authorization', `Bearer ${token(roles, system)}`).expect(403);
      expectNoServiceCalls();
    });
  });

  it('uses current database roles after an Admin is demoted', async () => {
    const adminToken = token([vmmsRole(UserRole.ADMIN)]);
    await request(app.getHttpServer()).post('/checklists/sync')
      .set('Authorization', `Bearer ${adminToken}`).send({}).expect(201);
    jest.clearAllMocks();
    setUser([vmmsRole(UserRole.OPERATIONS)]);
    await request(app.getHttpServer()).post('/checklists/sync')
      .set('Authorization', `Bearer ${adminToken}`).send({}).expect(403);
    expectNoServiceCalls();
  });

  it('rejects expired and incorrectly signed tokens', async () => {
    const payload = { sub: 'user-id', system: SystemType.VMMS, roles: [vmmsRole(UserRole.ADMIN)] };
    for (const invalidToken of [jwt.sign(payload, { expiresIn: -1 }), jwt.sign(payload, { secret: 'wrong-secret' })]) {
      await request(app.getHttpServer()).post('/checklists/sync')
        .set('Authorization', `Bearer ${invalidToken}`).send({}).expect(401);
    }
    expectNoServiceCalls();
  });

  it.each([
    ['inactive', { isActive: false, lockedAt: null }, 401],
    ['locked', { isActive: true, lockedAt: new Date() }, 403],
  ] as const)('rejects %s Admin accounts', async (_, state, status) => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-id', roles: [vmmsRole(UserRole.ADMIN)], ...state });
    await request(app.getHttpServer()).post('/checklists/sync')
      .set('Authorization', `Bearer ${token([vmmsRole(UserRole.ADMIN)])}`).send({}).expect(status);
    expectNoServiceCalls();
  });
});
