import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { BlobStorageService } from '../../../shared/blob-storage.service';
import { PrismaService } from '../../../shared/prisma.service';
import { FuelController } from './fuel.controller';
import { FuelService } from './fuel.service';

const vehicleId = '00000000-0000-4000-8000-000000000301';
const stationId = '00000000-0000-4000-8000-000000000302';
const voidedFillUpId = '00000000-0000-4000-8000-000000000303';
const vmmsOperations = [{ role: UserRole.OPERATIONS, system: SystemType.VMMS }];

describe('Fuel baseline and void API behavior', () => {
  let app: INestApplication;
  const fillUps: any[] = [];
  const anomalies: any[] = [];
  const attachments: any[] = [];
  const auditRows: any[] = [];
  const storedBlobs = new Map<string, Buffer>();
  const blobStorage = {
    put: jest.fn(async (key: string, body: Buffer) => { storedBlobs.set(key, body); }),
    get: jest.fn(async (key: string) => storedBlobs.get(key) ?? Buffer.from('fuel report body')),
    delete: jest.fn(async (key: string) => { storedBlobs.delete(key); }),
  };
  let nextId = 1;

  const actor = { sub: 'ops-user', email: 'ops@example.test', roles: vmmsOperations };
  const dateFor = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000);
  const makeRow = (id: string, odometer: number, daysAgo: number, isFullTank = true, liters = 100) => ({
    id, vehicleId, stationId, enteredById: actor.sub, filledBy: 'Operations',
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
      findFirst: jest.fn(({ where }: any) => Promise.resolve(where.id === actor.sub ? actor : null)),
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
      findMany: jest.fn(() => Promise.resolve(anomalies)),
      findUnique: jest.fn(({ where }: any) => Promise.resolve(anomalies.find((anomaly) => anomaly.id === where.id) ?? null)),
      updateMany: jest.fn(({ where, data }: any) => {
        const anomaly = anomalies.find((item) => {
          if (item.id !== where.id || item.status !== where.status) return false;
          if (where.acknowledgedAt === null && item.acknowledgedAt !== null) return false;
          if (where.acknowledgedAt?.not === null && item.acknowledgedAt === null) return false;
          const createdAtLimit = where.createdAt?.lte;
          if (createdAtLimit && item.createdAt > createdAtLimit) return false;
          return true;
        });
        if (anomaly) Object.assign(anomaly, data);
        return Promise.resolve({ count: anomaly ? 1 : 0 });
      }),
      findUniqueOrThrow: jest.fn(({ where }: any) => Promise.resolve(anomalies.find((anomaly) => anomaly.id === where.id))),
    },
    fuelAnomalyAttachment: {
      create: jest.fn(({ data }: any) => { attachments.push(data); return Promise.resolve(data); }),
      findFirst: jest.fn(),
    },
    fuelAuditLog: { create: jest.fn(({ data }: any) => { auditRows.push(data); return Promise.resolve(data); }) },
    $transaction: jest.fn((callback: (tx: any) => unknown) => callback(prisma)),
  };

  const auth = (method: 'get' | 'post' | 'patch', path: string) => request(app.getHttpServer())[method](path);
  const asRole = (role: UserRole) => {
    actor.sub = `${role.toLowerCase()}-user`;
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
      controllers: [FuelController],
      providers: [
        RolesGuard,
        FuelService,
        { provide: PrismaService, useValue: prisma },
        { provide: BlobStorageService, useValue: blobStorage },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({
      canActivate: (context: any) => { context.switchToHttp().getRequest().user = actor; return true; },
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    actor.sub = 'ops-user';
    actor.email = 'ops@example.test';
    actor.roles = vmmsOperations;
    fillUps.length = 0;
    anomalies.length = 0;
    attachments.length = 0;
    auditRows.length = 0;
    storedBlobs.clear();
    nextId = 1;
    jest.clearAllMocks();
    prisma.fuelAnomalyAttachment.findFirst.mockResolvedValue(null);
  });

  afterEach(() => { jest.restoreAllMocks(); });

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
    expect(auditRows).toContainEqual(expect.objectContaining({ action: 'VOIDED', reason: 'Duplicate receipt', actorId: actor.sub }));

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
      acknowledgedById: actor.sub,
      acknowledgment: 'Reviewed fuel receipt and vehicle history.',
    });
    expect(response.body.acknowledgedAt).toBeTruthy();
    expect(auditRows).toContainEqual(expect.objectContaining({
      fillUpId: voidedFillUpId,
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'ANOMALY_ACKNOWLEDGED',
      details: { anomalyId: voidedFillUpId, remark: 'Reviewed fuel receipt and vehicle history.' },
    }));
  });

  it('serves the mobile approval contract and returns the acknowledged anomaly on the next fetch', async () => {
    const anomaly = {
      id: voidedFillUpId,
      status: 'OPEN',
      createdAt: dateFor(8),
      acknowledgedAt: null,
      acknowledgedById: null,
      acknowledgment: null,
      fillUpId: voidedFillUpId,
      efficiency: 2.4,
      rollingAverage: 6.8,
      note: 'Operations reviewed the fuel entry.',
      vehicle: { plateNumber: 'NDG 5821' },
    };
    anomalies.push(anomaly);
    asRole(UserRole.CHIEF_MECHANIC);

    const initial = await auth('get', '/fuel/anomalies').expect(200);
    expect(initial.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: voidedFillUpId,
        status: 'OPEN',
        severity: 'CRITICAL',
        efficiency: 2.4,
        rollingAverage: 6.8,
        note: 'Operations reviewed the fuel entry.',
        acknowledgedAt: null,
        vehicle: expect.objectContaining({ plateNumber: 'NDG 5821' }),
      }),
    ]));

    const acknowledgment = await auth('post', `/fuel/anomalies/${voidedFillUpId}/acknowledge`)
      .send({ remark: 'Checked against the receipt.' })
      .expect(201);
    expect(acknowledgment.body).toMatchObject({
      id: voidedFillUpId,
      acknowledgedById: actor.sub,
      acknowledgment: 'Checked against the receipt.',
    });
    expect(acknowledgment.body.acknowledgedAt).toBeTruthy();

    const refreshed = await auth('get', '/fuel/anomalies').expect(200);
    expect(refreshed.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: voidedFillUpId,
        severity: 'CRITICAL',
        acknowledgedAt: acknowledgment.body.acknowledgedAt,
        acknowledgedById: actor.sub,
        acknowledgment: 'Checked against the receipt.',
        vehicle: expect.objectContaining({ plateNumber: 'NDG 5821' }),
      }),
    ]));
  });

  it('denies a mobile Mechanic access to Chief Mechanic fuel approvals before querying anomalies', async () => {
    asRole(UserRole.MECHANIC);

    await auth('get', '/fuel/anomalies').expect(403);

    expect(prisma.fuelAnomaly.findMany).not.toHaveBeenCalled();
  });

  it('lets Operations resolve an acknowledged Critical anomaly and records the resolution actor', async () => {
    const anomaly = {
      id: voidedFillUpId,
      status: 'OPEN',
      createdAt: dateFor(8),
      acknowledgedAt: dateFor(1),
      acknowledgedById: 'chief-mechanic-user',
      acknowledgment: 'Reviewed fuel receipt and vehicle history.',
      fillUpId: voidedFillUpId,
    };
    anomalies.push(anomaly);
    asRole(UserRole.OPERATIONS);

    const response = await auth('patch', `/fuel/anomalies/${voidedFillUpId}`)
      .send({})
      .expect(200);

    expect(response.body).toMatchObject({
      id: voidedFillUpId,
      status: 'RESOLVED',
      acknowledgedById: 'chief-mechanic-user',
      resolvedById: actor.sub,
    });
    expect(response.body.resolvedAt).toBeTruthy();
    expect(auditRows).toContainEqual(expect.objectContaining({
      fillUpId: voidedFillUpId,
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'ANOMALY_RESOLVED',
    }));
  });

  it('blocks Operations from resolving a Critical anomaly before acknowledgment', async () => {
    const anomaly = {
      id: voidedFillUpId,
      status: 'OPEN',
      createdAt: dateFor(8),
      acknowledgedAt: null,
      fillUpId: voidedFillUpId,
    };
    anomalies.push(anomaly);
    asRole(UserRole.OPERATIONS);

    await auth('patch', `/fuel/anomalies/${voidedFillUpId}`)
      .send({})
      .expect(400);

    expect(anomaly.status).toBe('OPEN');
    expect(anomaly.acknowledgedAt).toBeNull();
    expect(auditRows).toHaveLength(0);
    expect(prisma.fuelAnomaly.updateMany).not.toHaveBeenCalled();
  });

  it('lets Operations save a note on an unacknowledged Critical anomaly without resolving it', async () => {
    const anomaly = {
      id: voidedFillUpId,
      status: 'OPEN',
      createdAt: dateFor(8),
      acknowledgedAt: null,
      fillUpId: voidedFillUpId,
      note: null,
    };
    anomalies.push(anomaly);
    asRole(UserRole.OPERATIONS);

    const response = await auth('patch', `/fuel/anomalies/${voidedFillUpId}`)
      .send({ note: 'Checked the odometer and fuel receipt.' })
      .expect(200);

    expect(response.body).toMatchObject({
      id: voidedFillUpId,
      status: 'OPEN',
      acknowledgedAt: null,
      note: 'Checked the odometer and fuel receipt.',
      notedById: actor.sub,
    });
    expect(auditRows).toContainEqual(expect.objectContaining({
      fillUpId: voidedFillUpId,
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'ANOMALY_NOTE',
      details: { anomalyId: voidedFillUpId, note: 'Checked the odometer and fuel receipt.' },
    }));
    expect(auditRows.some((entry) => entry.action === 'ANOMALY_RESOLVED')).toBe(false);
  });

  it('rejects anomaly report uploads before Day 3', async () => {
    const anomaly = {
      id: voidedFillUpId,
      status: 'OPEN',
      createdAt: dateFor(2),
      acknowledgedAt: null,
      fillUpId: voidedFillUpId,
    };
    anomalies.push(anomaly);
    asRole(UserRole.OPERATIONS);

    await auth('post', `/fuel/anomalies/${voidedFillUpId}/attachments`)
      .attach('file', Buffer.from('%PDF-1.4 test report'), { filename: 'report.pdf', contentType: 'application/pdf' })
      .expect(400);

    expect(blobStorage.put).not.toHaveBeenCalled();
    expect(prisma.fuelAnomalyAttachment.create).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('allows Operations to attach and audit a PDF report from Day 3', async () => {
    const anomaly = {
      id: voidedFillUpId,
      status: 'OPEN',
      createdAt: dateFor(3),
      acknowledgedAt: null,
      fillUpId: voidedFillUpId,
    };
    anomalies.push(anomaly);
    asRole(UserRole.OPERATIONS);

    const response = await auth('post', `/fuel/anomalies/${voidedFillUpId}/attachments`)
      .attach('file', Buffer.from('%PDF-1.4 test report'), { filename: 'inspection-report.pdf', contentType: 'application/pdf' })
      .expect(201);

    expect(response.body).toMatchObject({
      anomalyId: voidedFillUpId,
      name: 'inspection-report.pdf',
      contentType: 'application/pdf',
      uploadedById: actor.sub,
    });
    expect(prisma.fuelAnomalyAttachment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        anomalyId: voidedFillUpId,
        name: 'inspection-report.pdf',
        contentType: 'application/pdf',
        uploadedById: actor.sub,
      }),
    }));
    expect(auditRows).toContainEqual(expect.objectContaining({
      fillUpId: voidedFillUpId,
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'ANOMALY_ATTACHMENT',
      details: expect.objectContaining({ anomalyId: voidedFillUpId }),
    }));
    expect(blobStorage.put).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['inspection-photo.jpg', 'image/jpeg'],
    ['inspection-photo.png', 'image/png'],
  ])('accepts %s formal reports from Day 3', async (filename, contentType) => {
    anomalies.push({ id: voidedFillUpId, status: 'OPEN', createdAt: dateFor(4), acknowledgedAt: null, fillUpId: voidedFillUpId });
    asRole(UserRole.OPERATIONS);

    const response = await auth('post', `/fuel/anomalies/${voidedFillUpId}/attachments`)
      .attach('file', Buffer.from('test image report'), { filename, contentType })
      .expect(201);

    expect(response.body).toMatchObject({ anomalyId: voidedFillUpId, name: filename, contentType, uploadedById: actor.sub });
    expect(auditRows).toContainEqual(expect.objectContaining({ actorId: actor.sub, action: 'ANOMALY_ATTACHMENT' }));
  });

  it.each([
    ['unsupported.txt', 'text/plain'],
    ['report.pdf', 'text/plain'],
    ['photo.jpg', 'application/pdf'],
  ])('rejects invalid anomaly report upload %s (%s) without persisting it', async (filename, contentType) => {
    anomalies.push({ id: voidedFillUpId, status: 'OPEN', createdAt: dateFor(4), acknowledgedAt: null, fillUpId: voidedFillUpId });
    asRole(UserRole.OPERATIONS);

    await auth('post', `/fuel/anomalies/${voidedFillUpId}/attachments`)
      .attach('file', Buffer.from('invalid report payload'), { filename, contentType })
      .expect(400);

    expect(blobStorage.put).not.toHaveBeenCalled();
    expect(prisma.fuelAnomalyAttachment.create).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('allows Admin, Operations, and Chief Mechanic to download attachments without logging downloads', async () => {
    prisma.fuelAnomalyAttachment.findFirst.mockResolvedValue({
      id: voidedFillUpId,
      anomalyId: stationId,
      name: 'formal-report.pdf',
      storageName: `fuel-anomalies/${stationId}/${voidedFillUpId}.pdf`,
      contentType: 'application/pdf',
      anomaly: { id: stationId },
    });

    for (const role of [UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC]) {
      asRole(role);
      const response = await auth('get', `/fuel/anomalies/${stationId}/attachments/${voidedFillUpId}`).expect(200);
      expect(response.headers['content-type']).toContain('application/pdf');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['content-disposition']).toBe('inline; filename="formal-report.pdf"');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }

    expect(blobStorage.get).toHaveBeenCalledTimes(3);
    expect(prisma.fuelAnomalyAttachment.findFirst).toHaveBeenCalledTimes(3);
    expect(auditRows).toHaveLength(0);
  });

  it('denies Mechanics attachment downloads before looking up the file', async () => {
    asRole(UserRole.MECHANIC);

    await auth('get', `/fuel/anomalies/${stationId}/attachments/${voidedFillUpId}`).expect(403);

    expect(prisma.fuelAnomalyAttachment.findFirst).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('does not return an attachment when its ID belongs to a different anomaly', async () => {
    asRole(UserRole.OPERATIONS);

    await auth('get', `/fuel/anomalies/${stationId}/attachments/${voidedFillUpId}`).expect(404);

    expect(prisma.fuelAnomalyAttachment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: voidedFillUpId, anomalyId: stationId },
    }));
    expect(blobStorage.get).not.toHaveBeenCalled();
  });

  it('rejects a tampered attachment storage path before opening a file', async () => {
    asRole(UserRole.OPERATIONS);
    prisma.fuelAnomalyAttachment.findFirst.mockResolvedValue({
      id: voidedFillUpId,
      anomalyId: stationId,
      name: 'formal-report.pdf',
      storageName: '../secret.pdf',
      contentType: 'application/pdf',
      anomaly: { id: stationId },
    });

    await auth('get', `/fuel/anomalies/${stationId}/attachments/${voidedFillUpId}`).expect(404);

    expect(blobStorage.get).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('preserves multiple reports on one anomaly for independent downloads', async () => {
    anomalies.push({ id: stationId, status: 'OPEN', createdAt: dateFor(4), acknowledgedAt: null, fillUpId: voidedFillUpId });
    asRole(UserRole.OPERATIONS);

    const firstUpload = await auth('post', `/fuel/anomalies/${stationId}/attachments`)
      .attach('file', Buffer.from('%PDF-1.4 first report'), { filename: 'first-report.pdf', contentType: 'application/pdf' })
      .expect(201);
    const secondUpload = await auth('post', `/fuel/anomalies/${stationId}/attachments`)
      .attach('file', Buffer.from('second report image'), { filename: 'second-report.jpg', contentType: 'image/jpeg' })
      .expect(201);

    expect(attachments).toHaveLength(2);
    expect(new Set(attachments.map((attachment) => attachment.id)).size).toBe(2);
    expect(firstUpload.body).toMatchObject({ name: 'first-report.pdf', anomalyId: stationId });
    expect(secondUpload.body).toMatchObject({ name: 'second-report.jpg', anomalyId: stationId });
    expect(auditRows.filter((entry) => entry.action === 'ANOMALY_ATTACHMENT')).toHaveLength(2);

    prisma.fuelAnomalyAttachment.findFirst.mockImplementation(({ where }: any) => Promise.resolve(
      attachments.find((attachment) => attachment.id === where.id && attachment.anomalyId === where.anomalyId) ?? null,
    ));

    const firstDownload = await auth('get', `/fuel/anomalies/${stationId}/attachments/${firstUpload.body.id}`).expect(200);
    const secondDownload = await auth('get', `/fuel/anomalies/${stationId}/attachments/${secondUpload.body.id}`).expect(200);
    expect(firstDownload.headers['content-disposition']).toBe('inline; filename="first-report.pdf"');
    expect(secondDownload.headers['content-disposition']).toBe('inline; filename="second-report.jpg"');
    expect(prisma.fuelAnomalyAttachment.findFirst).toHaveBeenCalledTimes(2);
  });

  it('removes a written report when its database insert fails and skips the audit record', async () => {
    anomalies.push({ id: stationId, status: 'OPEN', createdAt: dateFor(4), acknowledgedAt: null, fillUpId: voidedFillUpId });
    asRole(UserRole.OPERATIONS);
    prisma.fuelAnomalyAttachment.create.mockRejectedValueOnce(new Error('Database unavailable'));

    await auth('post', `/fuel/anomalies/${stationId}/attachments`)
      .attach('file', Buffer.from('%PDF-1.4 report'), { filename: 'failed-report.pdf', contentType: 'application/pdf' })
      .expect(500);

    expect(blobStorage.put).toHaveBeenCalledTimes(1);
    expect(blobStorage.delete).toHaveBeenCalledTimes(1);
    expect(blobStorage.delete).toHaveBeenCalledWith(expect.stringContaining('fuel-anomalies/'));
    expect(prisma.fuelAnomalyAttachment.create).toHaveBeenCalledTimes(1);
    expect(auditRows).toHaveLength(0);
  });

  it('rejects report uploads larger than 10 MB before persistence', async () => {
    asRole(UserRole.OPERATIONS);
    const oversizedReport = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');

    await auth('post', `/fuel/anomalies/${stationId}/attachments`)
      .attach('file', oversizedReport, { filename: 'oversized-report.pdf', contentType: 'application/pdf' })
      .expect(413);

    expect(blobStorage.put).not.toHaveBeenCalled();
    expect(prisma.fuelAnomalyAttachment.create).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('accepts a report exactly 10 MB in size', async () => {
    anomalies.push({ id: stationId, status: 'OPEN', createdAt: dateFor(4), acknowledgedAt: null, fillUpId: voidedFillUpId });
    asRole(UserRole.OPERATIONS);
    const boundaryReport = Buffer.alloc(10 * 1024 * 1024, 'x');

    const response = await auth('post', `/fuel/anomalies/${stationId}/attachments`)
      .attach('file', boundaryReport, { filename: 'maximum-size-report.pdf', contentType: 'application/pdf' })
      .expect(201);

    expect(response.body).toMatchObject({
      anomalyId: stationId,
      name: 'maximum-size-report.pdf',
      contentType: 'application/pdf',
      uploadedById: actor.sub,
    });
    expect(blobStorage.put).toHaveBeenCalledTimes(1);
    expect(prisma.fuelAnomalyAttachment.create).toHaveBeenCalledTimes(1);
    expect(auditRows).toContainEqual(expect.objectContaining({ actorId: actor.sub, action: 'ANOMALY_ATTACHMENT' }));
  });
});

