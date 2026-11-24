import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SystemType, UserRole } from '@prisma/client';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { VrmsRepairReadsService } from '../integrations/vrms/vrms-repair-reads.service';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

type Role = { role: UserRole; system: SystemType };
const secret = 'vehicle-permissions-test-only';
const vehicleId = '8da72728-b06e-4475-945e-2cf3c99a996e';
const roleFor = (role: UserRole): Role => ({ role, system: SystemType.VMMS });

describe('vehicle HTTP permissions', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret });
  const service = {
    create: jest.fn(),
    update: jest.fn(),
    updateOdometer: jest.fn(),
    delete: jest.fn(),
    findAll: jest.fn(),
    findAuditHistory: jest.fn(),
    getMaintenanceDefaults: jest.fn(),
    updateMaintenanceDefaults: jest.fn(),
    previewExcel: jest.fn(),
    saveImportRows: jest.fn(),
    previewOdometerExcel: jest.fn(),
    saveOdometerImportRows: jest.fn(),
  };
  const writes: ['post' | 'patch' | 'delete', string, keyof typeof service][] =
    [
      ['post', '/vehicles', 'create'],
      ['patch', `/vehicles/${vehicleId}`, 'update'],
      ['patch', `/vehicles/${vehicleId}/odometer`, 'updateOdometer'],
      ['delete', `/vehicles/${vehicleId}`, 'delete'],
    ];
  const token = (roles: Role[], system: SystemType = SystemType.VMMS) =>
    jwt.sign({ sub: 'user-id', email: 'test@example.invalid', roles, system });
  const expectNoWrites = () => {
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.updateOdometer).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.updateMaintenanceDefaults).not.toHaveBeenCalled();
    expect(service.previewOdometerExcel).not.toHaveBeenCalled();
    expect(service.saveOdometerImportRows).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [VehiclesController],
      providers: [
        { provide: VehiclesService, useValue: service },
        { provide: VrmsRepairReadsService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const auth =
            ctx.switchToHttp().getRequest().headers.authorization ?? '';
          if (!auth.startsWith('Bearer ')) throw new UnauthorizedException();
          try {
            ctx.switchToHttp().getRequest().user = jwt.verify(auth.slice(7));
            return true;
          } catch {
            throw new UnauthorizedException();
          }
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
    for (const method of Object.values(service))
      method.mockResolvedValue({ ok: true });
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(writes)('rejects anonymous %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
    expectNoWrites();
  });

  it.each(writes)('allows Operations %s %s', async (method, path, handler) => {
    const body = path.endsWith('/odometer')
      ? { odometer: 100 }
      : method === 'post'
        ? {
            plateNumber: 'ABC123',
            make: 'Isuzu',
            model: 'Truck',
            year: 2022,
            engineType: 'Diesel',
            truckSizeCategory: 'Medium Duty',
            odometer: 100,
            garageId: '8da72728-b06e-4475-945e-2cf3c99a996e',
          }
        : { make: 'Hino' };
    await request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .send(body)
      .expect(method === 'post' ? 201 : 200);
    expect(service[handler]).toHaveBeenCalledTimes(1);
  });

  it('rejects master odometer changes on the generic vehicle update route', async () => {
    await request(app.getHttpServer())
      .patch(`/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .send({ odometer: 125 })
      .expect(400);

    expect(service.update).not.toHaveBeenCalled();
  });

  it('allows Operations to update a vehicle odometer', async () => {
    await request(app.getHttpServer())
      .patch(`/vehicles/${vehicleId}/odometer`)
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .send({ odometer: 125 })
      .expect(200);

    expect(service.updateOdometer).toHaveBeenCalledWith(
      vehicleId,
      125,
      expect.objectContaining({
        sub: 'user-id',
        email: 'test@example.invalid',
      }),
    );
  });

  it('lets only Operations manage vehicle maintenance defaults', async () => {
    const body = {
      baseIntervalKm: '5000',
      baseBufferDistanceKm: '500',
      categoryOverrides: [
        {
          checklistTemplateId: vehicleId,
          intervalKm: '8000',
          bufferDistanceKm: '800',
        },
      ],
    };

    await request(app.getHttpServer())
      .get(`/vehicles/${vehicleId}/maintenance-defaults`)
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .expect(200);
    expect(service.getMaintenanceDefaults).toHaveBeenCalledWith(vehicleId);

    await request(app.getHttpServer())
      .put(`/vehicles/${vehicleId}/maintenance-defaults`)
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .send(body)
      .expect(200);
    expect(service.updateMaintenanceDefaults).toHaveBeenCalledWith(
      vehicleId,
      expect.objectContaining(body),
    );

    await request(app.getHttpServer())
      .put(`/vehicles/${vehicleId}/maintenance-defaults`)
      .set('Authorization', `Bearer ${token([roleFor(UserRole.ADMIN)])}`)
      .send(body)
      .expect(403);
  });

  it('allows Operations to preview an XLSX workbook without saving vehicles', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Plate Number']]),
      'Vehicles',
    );
    const buffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    service.previewExcel.mockResolvedValue({ imported: 0, rows: [] });

    await request(app.getHttpServer())
      .post('/vehicles/import/preview')
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .attach('file', buffer, {
        filename: 'vehicles.xlsx',
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      .expect(201, { imported: 0, rows: [] });
    expect(service.previewExcel).toHaveBeenCalledWith(expect.any(Buffer));
    expect(service.saveImportRows).not.toHaveBeenCalled();
  });

  it('saves only when Operations explicitly submits the reviewed rows', async () => {
    service.saveImportRows.mockResolvedValue({ imported: 1, rows: [] });
    await request(app.getHttpServer())
      .post('/vehicles/import')
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .send({
        rows: [
          {
            row: 2,
            plateNumber: 'ABC-123',
            make: 'Isuzu',
            model: 'NKR',
            year: '2022',
            engineType: 'Diesel',
            truckSizeCategory: 'Medium',
            garageBranch: 'Marikina',
            odometerBaseline: '100',
          },
        ],
      })
      .expect(201, { imported: 1, rows: [] });
    expect(service.saveImportRows).toHaveBeenCalledWith(expect.any(Array));
  });

  it('allows Operations to preview odometer readings without saving them', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Plate Number', 'Odometer Reading (km)'],
        ['ABC123', 125],
      ]),
      'Odometers',
    );
    const buffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    service.previewOdometerExcel.mockResolvedValue({
      updated: 0,
      unchanged: 0,
      rows: [],
    });

    await request(app.getHttpServer())
      .post('/vehicles/odometer/import/preview')
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .attach('file', buffer, {
        filename: 'odometer-readings.xlsx',
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      .expect(201, { updated: 0, unchanged: 0, rows: [] });
    expect(service.previewOdometerExcel).toHaveBeenCalledWith(
      expect.any(Buffer),
    );
    expect(service.saveOdometerImportRows).not.toHaveBeenCalled();
  });

  it('saves reviewed odometer rows and passes the Operations identity', async () => {
    service.saveOdometerImportRows.mockResolvedValue({
      updated: 1,
      unchanged: 0,
      rows: [],
    });
    const rows = [{ row: 2, plateNumber: 'ABC123', odometerReading: '125' }];

    await request(app.getHttpServer())
      .post('/vehicles/odometer/import')
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .send({ rows })
      .expect(201, { updated: 1, unchanged: 0, rows: [] });

    expect(service.saveOdometerImportRows).toHaveBeenCalledWith(
      rows,
      expect.objectContaining({
        sub: 'user-id',
        email: 'test@example.invalid',
      }),
    );
  });

  it('denies Admin access to vehicle import', async () => {
    await request(app.getHttpServer())
      .post('/vehicles/import/preview')
      .set('Authorization', `Bearer ${token([roleFor(UserRole.ADMIN)])}`)
      .attach('file', Buffer.from('file'), 'vehicles.xlsx')
      .expect(403);
    expect(service.previewExcel).not.toHaveBeenCalled();
    expect(service.saveImportRows).not.toHaveBeenCalled();
  });

  it('denies Admin access to bulk odometer import', async () => {
    await request(app.getHttpServer())
      .post('/vehicles/odometer/import')
      .set('Authorization', `Bearer ${token([roleFor(UserRole.ADMIN)])}`)
      .send({ rows: [] })
      .expect(403);
    expect(service.previewOdometerExcel).not.toHaveBeenCalled();
    expect(service.saveOdometerImportRows).not.toHaveBeenCalled();
  });

  it('passes the authenticated editor identity to the vehicle update service', async () => {
    await request(app.getHttpServer())
      .patch(`/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${token([roleFor(UserRole.OPERATIONS)])}`)
      .send({ make: 'Hino' })
      .expect(200);

    expect(service.update).toHaveBeenCalledWith(
      vehicleId,
      { make: 'Hino' },
      expect.objectContaining({
        sub: 'user-id',
        email: 'test@example.invalid',
        roles: [roleFor(UserRole.OPERATIONS)],
        system: SystemType.VMMS,
      }),
    );
  });

  describe.each([UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC])(
    '%s cannot manage vehicles',
    (role) => {
      it.each(writes)('denies %s %s', async (method, path) => {
        await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${token([roleFor(role)])}`)
          .send({ isActive: false })
          .expect(403);
        expectNoWrites();
      });
    },
  );

  it.each([
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.MECHANIC,
    UserRole.CHIEF_MECHANIC,
  ])('preserves vehicle reads for %s', async (role) => {
    const readRequest = request(app.getHttpServer())
      .get('/vehicles')
      .set('Authorization', `Bearer ${token([roleFor(role)])}`);
    await readRequest.expect(200);
    expect(service.findAll).toHaveBeenCalledTimes(1);
  });

  it.each([UserRole.ADMIN, UserRole.OPERATIONS])(
    'allows %s to read vehicle audit history',
    async (role) => {
      await request(app.getHttpServer())
        .get(`/vehicles/${vehicleId}/audit`)
        .set('Authorization', `Bearer ${token([roleFor(role)])}`)
        .expect(200);
      expect(service.findAuditHistory).toHaveBeenCalledWith(vehicleId);
    },
  );

  it.each([UserRole.MECHANIC, UserRole.CHIEF_MECHANIC])(
    'denies %s access to vehicle audit history',
    async (role) => {
      await request(app.getHttpServer())
        .get(`/vehicles/${vehicleId}/audit`)
        .set('Authorization', `Bearer ${token([roleFor(role)])}`)
        .expect(403);
      expect(service.findAuditHistory).not.toHaveBeenCalled();
    },
  );

  describe.each([SystemType.VRMS, SystemType.BMS])(
    '%s cannot grant VMMS mutation access',
    (system) => {
      it.each(writes)(
        'denies %s %s despite spoofed subsystem context',
        async (method, path) => {
          const roles = [
            roleFor(UserRole.ADMIN),
            { role: UserRole.OPERATIONS, system },
          ];
          await request(app.getHttpServer())
            [method](`${path}?system=${system}`)
            .set('Authorization', `Bearer ${token(roles, system)}`)
            .set('Origin', `https://${system.toLowerCase()}.example.invalid`)
            .send({ roleAssignments: [{ role: UserRole.OPERATIONS, system }] })
            .expect(403);
          expectNoWrites();
        },
      );
    },
  );
});
