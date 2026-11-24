import * as XLSX from 'xlsx';
import { PrismaService } from '../../../shared/prisma.service';
import { BmsFleetChangesService } from '../integrations/bms/bms-fleet-changes.service';
import { VehiclesService } from './vehicles.service';

describe('VehiclesService odometer import', () => {
  const prisma = {
    $transaction: jest.fn(),
    maintenanceSchedule: { findMany: jest.fn(), updateMany: jest.fn() },
    vehicleAuditLog: { createMany: jest.fn() },
    vehicle: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const fleetChanges = { recordChange: jest.fn() };
  const service = new VehiclesService(
    prisma as unknown as PrismaService,
    {} as any,
    fleetChanges as unknown as BmsFleetChangesService,
  );
  const actor = { sub: 'operations-user', email: 'ops@example.test' };
  const workbook = (values: unknown[][]) => {
    const sheet = XLSX.utils.aoa_to_sheet(values);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Odometers');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.maintenanceSchedule.findMany.mockResolvedValue([]);
    prisma.vehicleAuditLog.createMany.mockResolvedValue({ count: 1 });
    fleetChanges.recordChange.mockResolvedValue(undefined);
  });

  it('previews valid, invalid, inactive, unknown, and duplicate rows', async () => {
    prisma.vehicle.findMany.mockResolvedValue([
      {
        id: 'vehicle-1',
        plateNumber: 'ABC 1234',
        odometer: 100,
        isActive: true,
      },
      {
        id: 'vehicle-2',
        plateNumber: 'LOW 1234',
        odometer: 200,
        isActive: true,
      },
      {
        id: 'vehicle-3',
        plateNumber: 'OFF 1234',
        odometer: 100,
        isActive: false,
      },
    ]);

    const result = await service.previewOdometerExcel(
      workbook([
        ['Plate Number', 'Odometer Reading (km)'],
        ['ABC 1234', 125],
        ['LOW 1234', 150],
        ['OFF 1234', 125],
        ['UNKNOWN', 125],
        ['DUP 1234', 125],
        ['DUP 1234', 130],
      ]),
    );

    expect(result.rows.map((row) => row.status)).toEqual([
      'READY',
      'ERROR',
      'ERROR',
      'ERROR',
      'ERROR',
      'ERROR',
    ]);
    expect(result.rows[0]).toMatchObject({
      currentOdometer: 100,
      odometerReading: '125',
    });
    expect(result.rows[1].errors[0]).toContain('cannot be lower');
    expect(result.rows[2].errors[0]).toContain('active vehicles');
    expect(result.rows[3].errors[0]).toContain('No active vehicle');
    expect(result.rows[4].errors[0]).toContain('duplicated');
    expect(result.rows[5].errors[0]).toContain('duplicated');
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('saves valid rows independently and returns a stale-row error', async () => {
    prisma.vehicle.findMany.mockResolvedValue([
      {
        id: 'vehicle-1',
        plateNumber: 'ABC 1234',
        odometer: 100,
        isActive: true,
      },
      {
        id: 'vehicle-2',
        plateNumber: 'DEF 5678',
        odometer: 100,
        isActive: true,
      },
    ]);
    prisma.vehicle.findUnique
      .mockResolvedValueOnce({
        odometer: 100,
        isActive: true,
        deletedAt: null,
      })
      .mockResolvedValueOnce({
        id: 'vehicle-1',
        plateNumber: 'ABC 1234',
        odometer: 120,
        isActive: true,
        deletedAt: null,
        garage: null,
      })
      .mockResolvedValueOnce({
        odometer: 170,
        isActive: true,
        deletedAt: null,
      })
      .mockResolvedValueOnce({ odometer: 170, deletedAt: null });
    prisma.vehicle.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.saveOdometerImportRows(
      [
        { row: 2, plateNumber: 'ABC 1234', odometerReading: '120' },
        { row: 3, plateNumber: 'DEF 5678', odometerReading: '150' },
      ],
      actor,
    );

    expect(result).toMatchObject({
      updated: 1,
      unchanged: 0,
      rows: [
        { row: 2, currentOdometer: 120, status: 'UPDATED', errors: [] },
        {
          row: 3,
          currentOdometer: 170,
          status: 'ERROR',
          errors: [expect.stringContaining('cannot be lower')],
        },
      ],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.vehicle.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleAuditLog.createMany).toHaveBeenCalledTimes(1);
  });
});
