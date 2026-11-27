import { INestApplication, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { PrismaService } from '../../../shared/prisma.service';
import { AuditController } from './audit.controller';

describe('Business audit API authorization', () => {
  let app: INestApplication;
  const actor = {
    sub: 'admin-user',
    email: 'admin@example.test',
    roles: [{ role: UserRole.ADMIN, system: SystemType.VMMS }],
    system: SystemType.VMMS,
  };
  const findMany = jest.fn().mockResolvedValue([]);
  const costingExportFindMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    vehicleAuditLog: { findMany },
    fuelAuditLog: { findMany: jest.fn().mockResolvedValue([]) },
    maintenanceScheduleCancellation: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    maintenanceCostingThresholdAudit: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    maintenanceCostingExportAudit: {
      findMany: costingExportFindMany,
    },
    maintenanceLogEditUnlock: { findMany: jest.fn().mockResolvedValue([]) },
    maintenanceLogEditAudit: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const auditQueries = [
    prisma.vehicleAuditLog.findMany,
    prisma.fuelAuditLog.findMany,
    prisma.maintenanceScheduleCancellation.findMany,
    prisma.maintenanceCostingThresholdAudit.findMany,
    prisma.maintenanceCostingExportAudit.findMany,
    prisma.maintenanceLogEditUnlock.findMany,
    prisma.maintenanceLogEditAudit.findMany,
  ];

  const asRole = (role: UserRole) => {
    actor.sub = `${role.toLowerCase()}-user`;
    actor.email = `${role.toLowerCase()}@example.test`;
    actor.roles = [{ role, system: SystemType.VMMS }];
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        RolesGuard,
        { provide: PrismaService, useValue: prisma },
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

  it('allows Admin to load business audit records', async () => {
    asRole(UserRole.ADMIN);

    const response = await request(app.getHttpServer())
      .get('/vmms/audit-logs/business')
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ records: [] });
    expect(auditQueries.every((query) => query.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it('includes export metadata without report amounts in business audit', async () => {
    asRole(UserRole.ADMIN);
    costingExportFindMany.mockResolvedValueOnce([
      {
        id: 'export-1',
        actorEmail: 'admin@example.test',
        format: 'XLSX',
        fromDate: new Date('2026-06-01T00:00:00.000Z'),
        toDate: new Date('2026-06-30T00:00:00.000Z'),
        selectedTruckPlate: 'ABC123',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ]);

    const response = await request(app.getHttpServer())
      .get('/vmms/audit-logs/business')
      .expect(200);

    expect(response.body.records).toContainEqual(
      expect.objectContaining({
        id: 'export-1',
        action: 'COSTING_EXPORTED',
        category: 'maintenance_costing',
        details: '2026-06-01 to 2026-06-30 · Truck ABC123',
      }),
    );
    expect(JSON.stringify(response.body.records)).not.toMatch(/totalCost|revenue|profit/);
  });

  it.each([
    UserRole.OPERATIONS,
    UserRole.CHIEF_MECHANIC,
    UserRole.MECHANIC,
  ])('denies %s before reading business audit records', async (role) => {
    asRole(role);

    await request(app.getHttpServer())
      .get('/vmms/audit-logs/business')
      .expect(403);

    expect(
      auditQueries.every((query) => query.mock.calls.length === 0),
    ).toBe(true);
  });
});
