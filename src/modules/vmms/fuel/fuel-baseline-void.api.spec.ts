import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import { JwtStrategy } from '../../../auth/strategies/jwt.strategy';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { PrismaService } from '../../../shared/prisma.service';
import { FuelController } from './fuel.controller';
import { FuelService } from './fuel.service';

const vehicleId = '00000000-0000-4000-8000-000000000301';
const stationId = '00000000-0000-4000-8000-000000000302';
const voidedFillUpId = '00000000-0000-4000-8000-000000000303';
const vmmsOperations = [{ role: UserRole.OPERATIONS, system: SystemType.VMMS }];

describe('Fuel baseline and void API behavior', () => {
  let app: INestApplication;
  const secret = 'fuel-baseline-void-test-only';
  const jwt = new JwtService({ secret });
  const fillUps: any[] = [];
  const anomalies: any[] = [];
  const auditRows: any[] = [];
  let nextId = 1;

  const actor = { id: 'ops-user', email: 'ops@example.test', isActive: true, lockedAt: null, roles: vmmsOperations };
  const dateFor = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000);
  const makeRow = (id: string, odometer: number, daysAgo: number, isFullTank = true, liters = 100) => ({
    id, vehicleId, stationId, enteredById: actor.id, filledBy: 'Operations',
    entryDate: dateFor(daysAgo), createdAt: dateFor(daysAgo),
    liters, pricePerLiter: 60, totalCost: liters * 60, odometer, isFullTank,
    isVoided: false, vehicle: { id: vehicleId, plateNumber: 'NDG 5821', model: 'Test Truck' },
    station: { id: stationId, name: 'Petron' }, anomaly: null,
  });
  const previousOdometerLimit = (where: any) => {
    const limits = (where.OR ?? []).map((clause: any) => clause.odometer?.lt).filter((value: unknown) => typeof value === 'number');
    return limits.length ? Math.max(...limits) : Number.MAX_SAFE_INTEGER;
  };
  const prisma: any = {
    user: {
      findFirst: jest.fn(({ where }: any) => Promise.resolve(where.id === actor.id ? actor : null)),
    },
    vehicle: { findFirst: jest.fn(() => Promise.resolve({ id: vehicleId, plateNumber: 'NDG 5821', model: 'Test Truck', odometer: 0 })) },
    fuelStation: { findFirst: jest.fn(() => Promise.resolve({ id: stationId, name: 'Petron', isActive: true })) },
    fuelAnomalySetting: { findUnique: jest.fn(() => Promise.resolve({ thresholdPercent: 20 })) },
    fuelFillUp: {
      findMany: jest.fn(({ where }: any) => Promise.resolve(fillUps
        .filter((row) => (where.isVoided !== false || !row.isVoided) && (!where.vehicleId || row.vehicleId === where.vehicleId) && (!where.OR || (row.isFullTank && !row.isVoided && row.odometer < previousOdometerLimit(where))))
        .sort((a, b) => b.entryDate.getTime() - a.entryDate.getTime()))),
      findFirst: jest.fn(({ where }: any) => Promise.resolve(fillUps
        .filter((row) => row.vehicleId === where.vehicleId && !row.isVoided && row.id !== where.id?.not && (!where.isFullTank || row.isFullTank) && (!where.OR || row.odometer < previousOdometerLimit(where)))
        .sort((a, b) => b.odometer - a.odometer)[0] ?? null)),
      count: jest.fn(({ where }: any) => Promise.resolve(fillUps.filter((row) => row.vehicleId === where.vehicleId && row.isFullTank && !row.isVoided && row.odometer <= where.odometer.lte).length)),
      create: jest.fn(({ data }: any) => {
        const row = { ...makeRow(`created-${nextId++}`, data.odometer, 0, data.isFullTank, data.liters), ...data };
        fillUps.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(({ where, data }: any) => {
        const row = fillUps.find((entry) => entry.id === where.id);
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn(({ where }: any) => Promise.resolve(fillUps.find((row) => row.id === where.id) ?? null)),
      findUniqueOrThrow: jest.fn(({ where }: any) => Promise.resolve(fillUps.find((row) => row.id === where.id))),
    },
    fuelAnomaly: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(({ where }: any) => Promise.resolve(anomalies.find((anomaly) => anomaly.id === where.id) ?? null)),
      updateMany: jest.fn(({ where, data }: any) => {
        const anomaly = anomalies.find((item) => item.id === where.id && item.status === where.status && (!where.acknowledgedAt || item.acknowledgedAt === where.acknowledgedAt));
        if (anomaly) Object.assign(anomaly, data);
        return Promise.resolve({ count: anomaly ? 1 : 0 });
      }),
      findUniqueOrThrow: jest.fn(({ where }: any) => Promise.resolve(anomalies.find((anomaly) => anomaly.id === where.id))),
    },
    fuelAuditLog: { create: jest.fn(({ data }: any) => { auditRows.push(data); return Promise.resolve(data); }) },
    $transaction: jest.fn((callback: (tx: any) => unknown) => callback(prisma)),
  };

  const token = () => jwt.sign({ sub: actor.id, email: actor.email, roles: actor.roles, system: SystemType.VMMS, clientPlatform: actor.roles.some(({ role }) => role === UserRole.MECHANIC || role === UserRole.CHIEF_MECHANIC) ? 'mobile' : 'web' });
  const auth = (method: 'get' | 'post' | 'patch', path: string) => request(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${token()}`)
    .set('x-vmms-client', actor.roles.some(({ role }) => role === UserRole.MECHANIC || role === UserRole.CHIEF_MECHANIC) ? 'mobile' : 'web');
  const asRole = (role: UserRole) => {
    actor.id = `${role.toLowerCase()}-user`;
    actor.email = `${role.toLowerCase()}@example.test`;
    actor.roles = [{ role, system: SystemType.VMMS }];
  };
  const todayInManila = () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values['year']}-${values['month']}-${values['day']}`;
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [FuelController],
      providers: [
        JwtStrategy,
        RolesGuard,
        FuelService,
        { provide: ConfigService, useValue: { getOrThrow: () => secret } },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    actor.id = 'ops-user';
    actor.email = 'ops@example.test';
    actor.roles = vmmsOperations;
    fillUps.length = 0;
    anomalies.length = 0;
    auditRows.length = 0;
    nextId = 1;
    jest.clearAllMocks();
  });

  afterAll(async () => { await app?.close(); });

  it('keeps the classification Insufficient Data through partial fills until three full-tank entries exist', async () => {
    fillUps.push(makeRow('full-1', 1000, 30), makeRow('full-2', 2000, 20));

    const initial = await auth('get', '/fuel').expect(200);
    expect(initial.body.map((row: any) => row.fuelClassification)).toEqual(['Insufficient Data', 'Insufficient Data']);

    const partial = await auth('post', '/fuel').send({
      vehicleId, stationId, date: todayInManila(), liters: 30, pricePerLiter: 60,
      odometer: 2500, isFullTank: false, filledBy: 'Operations',
    }).expect(201);
    expect(partial.body).toMatchObject({ efficiency: null, fuelClassification: 'Insufficient Data' });

    const thirdFullTank = await auth('post', '/fuel').send({
      vehicleId, stationId, date: todayInManila(), liters: 100, pricePerLiter: 60,
      odometer: 3000, isFullTank: true, filledBy: 'Operations',
    }).expect(201);
    expect(thirdFullTank.body).toMatchObject({ efficiency: 10, fuelClassification: 'Normal' });
  });

  it('retains a voided full-tank entry in history but excludes it from efficiency and report totals', async () => {
    fillUps.push(makeRow('full-1', 1000, 40), makeRow('full-2', 2000, 30), makeRow(voidedFillUpId, 3000, 20), makeRow('full-4', 4000, 10));

    await auth('post', `/fuel/${voidedFillUpId}/void`).send({ reason: 'Duplicate receipt' }).expect(201);

    const history = await auth('get', '/fuel').expect(200);
    const voidedEntry = history.body.find((row: any) => row.id === voidedFillUpId);
    const latestEntry = history.body.find((row: any) => row.id === 'full-4');
    expect(voidedEntry).toMatchObject({ isVoided: true, efficiency: null });
    expect(latestEntry.efficiency).toBe(20);
    expect(auditRows).toContainEqual(expect.objectContaining({ action: 'VOIDED', reason: 'Duplicate receipt', actorId: actor.id }));

    const report = await auth('get', '/fuel/report').expect(200);
    expect(report.body.totals).toMatchObject({ totalFillUps: 3, totalLiters: 300, totalCost: 18000 });
    expect(report.body.entries.some((row: any) => row.id === voidedFillUpId)).toBe(false);
  });

  it('enforces the fuel role matrix at the API boundary', async () => {
    const validFillUp = {
      vehicleId, stationId, date: todayInManila(), liters: 10, pricePerLiter: 60,
      odometer: 1000, isFullTank: false, filledBy: 'Test operator',
    };

    asRole(UserRole.ADMIN);
    await auth('get', '/fuel').expect(200);
    await auth('get', '/fuel/anomaly-threshold').expect(200);
    await auth('post', '/fuel').send(validFillUp).expect(403);
    await auth('post', '/fuel/stations').send({ name: 'New station' }).expect(403);
    await auth('patch', `/fuel/stations/${stationId}`).send({ isActive: false }).expect(403);
    await auth('post', `/fuel/${voidedFillUpId}/void`).send({ reason: 'Duplicate' }).expect(403);
    await auth('patch', `/fuel/anomalies/${voidedFillUpId}`).send({ note: 'Resolved' }).expect(403);
    await auth('post', `/fuel/anomalies/${voidedFillUpId}/attachments`).expect(403);
    await auth('post', `/fuel/anomalies/${voidedFillUpId}/acknowledge`).send({ remark: 'Reviewed' }).expect(400);

    asRole(UserRole.OPERATIONS);
    await auth('get', '/fuel/anomaly-threshold').expect(200);
    await auth('patch', '/fuel/anomaly-threshold').send({ thresholdPercent: 15 }).expect(403);
    await auth('post', `/fuel/anomalies/${voidedFillUpId}/acknowledge`).send({ remark: 'Reviewed' }).expect(403);

    asRole(UserRole.CHIEF_MECHANIC);
    await auth('get', '/fuel/anomalies').expect(200);
    await auth('post', `/fuel/anomalies/${voidedFillUpId}/acknowledge`).send({ remark: 'Reviewed' }).expect(400);
    await auth('get', '/fuel/stations').expect(403);
    await auth('post', '/fuel').send(validFillUp).expect(403);
    await auth('post', `/fuel/${voidedFillUpId}/void`).send({ reason: 'Duplicate' }).expect(403);
    await auth('post', `/fuel/anomalies/${voidedFillUpId}/attachments`).expect(403);

    asRole(UserRole.MECHANIC);
    await auth('get', '/fuel/anomalies').expect(403);
  });

  it('lets Chief Mechanic acknowledge a critical anomaly and records the actor in the audit log', async () => {
    const anomaly = {
      id: voidedFillUpId,
      status: 'OPEN',
      createdAt: dateFor(8),
      acknowledgedAt: null,
      fillUpId: voidedFillUpId,
    };
    anomalies.push(anomaly);
    asRole(UserRole.CHIEF_MECHANIC);

    const response = await auth('post', `/fuel/anomalies/${voidedFillUpId}/acknowledge`)
      .send({ remark: 'Reviewed fuel receipt and vehicle history.' })
      .expect(201);

    expect(response.body).toMatchObject({
      id: voidedFillUpId,
      acknowledgedById: actor.id,
      acknowledgment: 'Reviewed fuel receipt and vehicle history.',
    });
    expect(response.body.acknowledgedAt).toBeTruthy();
    expect(auditRows).toContainEqual(expect.objectContaining({
      fillUpId: voidedFillUpId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'ANOMALY_ACKNOWLEDGED',
      details: { anomalyId: voidedFillUpId, remark: 'Reviewed fuel receipt and vehicle history.' },
    }));
  });
});
