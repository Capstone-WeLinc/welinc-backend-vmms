import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { PrismaService } from '../../../shared/prisma.service';
import { VehiclesService } from './vehicles.service';

describe('VehiclesService garage branch assignment', () => {
  const prisma = {
    $transaction: jest.fn(),
    garage: { findFirst: jest.fn(), findMany: jest.fn() },
    maintenanceSchedule: { findMany: jest.fn() },
    vehicleAuditLog: { createMany: jest.fn(), findMany: jest.fn() },
    vehicle: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new VehiclesService(prisma as unknown as PrismaService);
  const createDto = (overrides = {}) => ({
    plateNumber: 'ABC 1234',
    make: 'Isuzu',
    model: 'Elf',
    year: 2022,
    engineType: 'Diesel',
    truckSizeCategory: 'Light Duty',
    odometer: 100,
    garageId: 'garage-1',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
  });

  it('requires an active registered branch when creating a vehicle', async () => {
    prisma.garage.findFirst.mockResolvedValue({ id: 'garage-1' });
    prisma.vehicle.create.mockResolvedValue({ id: 'vehicle-1' });

    await service.create(createDto());

    expect(prisma.garage.findFirst).toHaveBeenCalledWith({
      where: { id: 'garage-1', isActive: true, deletedAt: null },
      select: { id: true },
    });
    expect(prisma.vehicle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ garageId: 'garage-1' }),
      }),
    );
  });

  it('rejects missing or inactive branches', async () => {
    await expect(service.create(createDto({ garageId: '' }))).rejects.toThrow(
      new BadRequestException('Garage branch is required.'),
    );
    prisma.garage.findFirst.mockResolvedValue(null);
    await expect(service.create(createDto())).rejects.toThrow(
      new BadRequestException('Select an active registered garage branch.'),
    );
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
  });

  it('returns the assigned branch name with each vehicle', async () => {
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      {
        vehicleId: 'ABC 1234',
        completedAt: new Date('2026-09-12T08:30:00.000Z'),
        createdAt: new Date('2026-08-12T08:30:00.000Z'),
      },
      {
        vehicleId: 'ABC 1234',
        completedAt: null,
        createdAt: new Date('2026-06-12T08:30:00.000Z'),
      },
    ]);
    prisma.vehicle.findMany.mockResolvedValue([
      {
        id: 'vehicle-1',
        plateNumber: 'ABC 1234',
        model: 'Isuzu Elf',
        capacity: 0,
        status: 'AVAILABLE',
        odometer: 100,
        garageId: 'garage-1',
        garage: { id: 'garage-1', name: 'Marikina' },
        isActive: true,
      },
    ]);

    await expect(service.findAll()).resolves.toEqual([
      expect.objectContaining({
        garageId: 'garage-1',
        garageName: 'Marikina',
        lastMaintenanceDate: new Date('2026-09-12T08:30:00.000Z'),
      }),
    ]);
    expect(prisma.maintenanceSchedule.findMany).toHaveBeenCalledWith({
      where: {
        vehicleId: { in: ['ABC 1234'] },
        status: 'COMPLETED',
        deletedAt: null,
      },
      orderBy: [
        { completedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      select: { vehicleId: true, completedAt: true, createdAt: true },
    });
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { garage: { select: { id: true, name: true } } },
      }),
    );
  });

  it('returns null when a vehicle has no completed maintenance schedule', async () => {
    prisma.vehicle.findMany.mockResolvedValue([
      { id: 'vehicle-2', plateNumber: 'NOHISTORY', garage: null },
    ]);
    prisma.maintenanceSchedule.findMany.mockResolvedValue([]);

    await expect(service.findAll()).resolves.toEqual([
      expect.objectContaining({
        plateNumber: 'NOHISTORY',
        lastMaintenanceDate: null,
      }),
    ]);
  });

  it('uses a completed seed schedule creation date when no completion timestamp exists', async () => {
    const seededDate = new Date('2026-06-14T00:00:00.000Z');
    prisma.vehicle.findMany.mockResolvedValue([
      { id: 'vehicle-3', plateNumber: 'SEEDED', garage: null },
    ]);
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      { vehicleId: 'SEEDED', completedAt: null, createdAt: seededDate },
    ]);

    await expect(service.findAll()).resolves.toEqual([
      expect.objectContaining({
        plateNumber: 'SEEDED',
        lastMaintenanceDate: seededDate,
      }),
    ]);
  });

  it('writes previous and new values for every changed vehicle field with the editor identity', async () => {
    const previous = {
      plateNumber: 'ABC 1234',
      make: 'Isuzu',
      model: 'Elf',
      year: 2022,
      engineType: 'Diesel',
      truckSizeCategory: 'Light Duty',
      capacity: 0,
      odometer: 100,
      garageId: 'garage-1',
      status: 'AVAILABLE',
      isActive: true,
    };
    prisma.vehicle.findUnique.mockResolvedValue(previous);
    prisma.vehicle.update.mockImplementation(({ data }) => ({
      ...previous,
      ...data,
      garage: { id: 'garage-1', name: 'Marikina' },
    }));
    prisma.vehicleAuditLog.createMany.mockResolvedValue({ count: 2 });

    await service.update(
      'vehicle-1',
      { make: '  Hino  ', odometer: 125 },
      {
        sub: 'operations-user',
        email: 'operations@example.test',
      },
    );

    expect(prisma.vehicleAuditLog.createMany).toHaveBeenCalledWith({
      data: [
        {
          vehicleId: 'vehicle-1',
          userId: 'operations-user',
          email: 'operations@example.test',
          action: 'VEHICLE_UPDATED',
          fieldName: 'make',
          previousValue: 'Isuzu',
          newValue: 'Hino',
        },
        {
          vehicleId: 'vehicle-1',
          userId: 'operations-user',
          email: 'operations@example.test',
          action: 'VEHICLE_UPDATED',
          fieldName: 'odometer',
          previousValue: '100',
          newValue: '125',
        },
      ],
    });
  });

  it('does not create edit audit rows when submitted values are unchanged', async () => {
    const unchanged = {
      plateNumber: 'ABC 1234',
      make: 'Isuzu',
      model: 'Elf',
      year: 2022,
      engineType: 'Diesel',
      truckSizeCategory: 'Light Duty',
      capacity: 0,
      odometer: 100,
      garageId: 'garage-1',
      status: 'AVAILABLE',
      isActive: true,
    };
    prisma.vehicle.findUnique.mockResolvedValue(unchanged);
    prisma.vehicle.update.mockResolvedValue({ ...unchanged, garage: null });

    await service.update(
      'vehicle-1',
      { make: ' Isuzu ' },
      {
        sub: 'operations-user',
        email: 'operations@example.test',
      },
    );

    expect(prisma.vehicleAuditLog.createMany).not.toHaveBeenCalled();
  });

  it('returns a vehicle audit history in newest-first order with a bounded result set', async () => {
    prisma.vehicle.findUnique.mockResolvedValue({ id: 'vehicle-1' });
    prisma.vehicleAuditLog.findMany.mockResolvedValue([
      {
        id: 'audit-1',
        email: 'ops@example.test',
        fieldName: 'make',
        previousValue: 'Isuzu',
        newValue: 'Hino',
      },
    ]);

    await expect(service.findAuditHistory('vehicle-1')).resolves.toHaveLength(
      1,
    );
    expect(prisma.vehicleAuditLog.findMany).toHaveBeenCalledWith({
      where: { vehicleId: 'vehicle-1' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        action: true,
        fieldName: true,
        previousValue: true,
        newValue: true,
        createdAt: true,
      },
    });
  });

  it('previews valid spreadsheet rows and reports duplicates without saving vehicles', async () => {
    const data = [
      [
        'Plate Number',
        'Make',
        'Model',
        'Year',
        'Engine Type',
        'Truck Size/Category',
        'Garage Branch',
        'Odometer Baseline',
      ],
    ];
    data.push([
      'EXISTING',
      'Isuzu',
      'NKR',
      '2022',
      'Diesel',
      'Medium',
      'Marikina',
      '100',
    ]);
    data.push([
      'TRUCK-1',
      'Isuzu',
      'NKR',
      '2022',
      'Diesel',
      'Medium',
      'Sta. Rosa',
      '100',
    ]);
    for (let index = 2; index <= 8; index += 1) {
      data.push([
        `TRUCK-${index}`,
        'Isuzu',
        'NKR',
        '2022',
        'Diesel',
        'Medium',
        'Pulilan',
        String(index * 100),
      ]);
    }
    data.push([
      'TRUCK-1',
      'Isuzu',
      'NKR',
      '2022',
      'Diesel',
      'Medium',
      'Marikina',
      '200',
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(data),
      'Vehicles',
    );
    const buffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    prisma.garage.findMany.mockResolvedValue([
      { id: 'marikina', name: 'Marikina' },
      { id: 'sta-rosa', name: 'Sta. Rosa' },
      { id: 'pulilan', name: 'Pulilan' },
    ]);
    prisma.vehicle.findMany.mockResolvedValue([{ plateNumber: 'EXISTING' }]);
    prisma.vehicle.create.mockResolvedValue({ id: 'created' });

    const preview = await service.previewExcel(buffer);
    expect(preview.imported).toBe(0);
    expect(preview.rows).toHaveLength(10);
    expect(preview.rows[0]).toMatchObject({ row: 2, plateNumber: 'EXISTING' });
    expect(preview.rows[0].errors[0]).toContain('already registered');
    expect(preview.rows[1]).toMatchObject({
      row: 3,
      plateNumber: 'TRUCK-1',
      errors: [],
    });
    expect(preview.rows[9]).toMatchObject({ row: 11, plateNumber: 'TRUCK-1' });
    expect(preview.rows[9].errors[0]).toContain('duplicated');
    expect(prisma.vehicle.create).not.toHaveBeenCalled();

    preview.rows[1].make = 'Hino';
    await expect(service.saveImportRows(preview.rows)).resolves.toMatchObject({
      imported: 8,
      rows: [
        {
          row: 2,
          plateNumber: 'EXISTING',
          errors: [expect.stringContaining('already registered')],
        },
        {
          row: 11,
          plateNumber: 'TRUCK-1',
          errors: [expect.stringContaining('already registered')],
        },
      ],
    });
    expect(prisma.vehicle.create).toHaveBeenCalledTimes(8);
    expect(prisma.vehicle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        plateNumber: 'TRUCK-1',
        garageId: 'sta-rosa',
        status: 'AVAILABLE',
        odometer: 100,
      }),
    });
    expect(prisma.vehicle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ plateNumber: 'TRUCK-1', make: 'Hino' }),
    });
  });

  it('previews missing values and unregistered garage branches without writing', async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      [
        'Plate Number',
        'Make',
        'Model',
        'Year',
        'Engine Type',
        'Truck Size/Category',
        'Garage Branch',
        'Odometer Baseline',
      ],
      ['MISSING', '', 'NKR', '2022', 'Diesel', 'Medium', 'Marikina', '100'],
      [
        'BAD-BRANCH',
        'Isuzu',
        'NKR',
        '2022',
        'Diesel',
        'Medium',
        'Nowhere',
        '100',
      ],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Vehicles');
    prisma.garage.findMany.mockResolvedValue([
      { id: 'marikina', name: 'Marikina' },
    ]);
    prisma.vehicle.findMany.mockResolvedValue([]);
    prisma.vehicle.create.mockResolvedValue({ id: 'created' });

    await expect(
      service.previewExcel(
        XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
      ),
    ).resolves.toMatchObject({
      imported: 0,
      rows: [
        { row: 2, errors: [expect.stringContaining('make')] },
        { row: 3, errors: [expect.stringContaining('registered branch')] },
      ],
    });
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
  });

  it('rejects workbooks without all expected columns', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Plate Number', 'Make']]),
      'Vehicles',
    );
    await expect(
      service.previewExcel(
        XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
      ),
    ).rejects.toThrow('Missing required columns');
  });
});
