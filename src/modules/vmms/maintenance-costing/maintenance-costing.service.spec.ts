import { BadRequestException } from '@nestjs/common';
import { MaintenanceApprovalStatus, MaintenanceStatus } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { MaintenanceCostingService } from './maintenance-costing.service';

describe('MaintenanceCostingService', () => {
  const prisma = {
    vehicle: { findMany: jest.fn() },
    maintenanceSchedule: { findMany: jest.fn() },
    maintenanceCostingSetting: { findUnique: jest.fn() },
    maintenanceCostingExportAudit: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  let service: MaintenanceCostingService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.vehicle.findMany.mockResolvedValue([
      {
        id: 'vehicle-1',
        plateNumber: 'ABC123',
        make: 'Hino',
        model: '500',
        isActive: true,
        garage: { name: 'Marikina' },
      },
      {
        id: 'vehicle-2',
        plateNumber: 'DEF456',
        make: 'Fuso',
        model: 'Canter',
        isActive: true,
        garage: { name: 'Pulilan' },
      },
    ]);
    prisma.maintenanceSchedule.findMany.mockResolvedValue([]);
    prisma.maintenanceCostingSetting.findUnique.mockResolvedValue({
      threshold: null,
    });
    prisma.maintenanceCostingExportAudit.create.mockResolvedValue({});
    service = new MaintenanceCostingService(prisma as any);
  });

  it('defaults the period to the current Philippine month and requests only approved completed records', async () => {
    const result = await service.getDashboard(
      undefined,
      undefined,
      new Date('2026-11-09T02:00:00.000Z'),
    );

    expect(result.period).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(prisma.maintenanceSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: MaintenanceStatus.COMPLETED,
          approvalStatus: MaintenanceApprovalStatus.VERIFIED,
          deletedAt: null,
        }),
      }),
    );
    expect(result.totalActiveTrucks).toBe(2);
  });

  it('aggregates completed approved costs by active fleet, excludes non-costing sources, and returns activity detail', async () => {
    prisma.maintenanceCostingSetting.findUnique.mockResolvedValue({
      threshold: { toNumber: () => 100 },
    });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      {
        id: 'work-1',
        workOrderNumber: 'WO-1',
        vehicleId: 'ABC123',
        title: 'Oil Change',
        assignedMechanic: 'Mechanic One',
        completedAt: new Date('2026-06-04T04:00:00.000Z'),
        partsCost: { toNumber: () => 80 },
        laborCost: { toNumber: () => 40 },
        totalCost: { toNumber: () => 999 },
        workOrderProgress: null,
        assignedMechanicUser: { name: 'Mechanic One' },
      },
      {
        id: 'history-only',
        workOrderNumber: 'WO-0',
        vehicleId: 'OUTSIDE',
        title: 'Unregistered vehicle',
        assignedMechanic: 'Mechanic Two',
        completedAt: new Date('2026-06-02T04:00:00.000Z'),
        partsCost: null,
        laborCost: null,
        totalCost: { toNumber: () => 500 },
        workOrderProgress: null,
        assignedMechanicUser: null,
      },
    ]);

    const result = await service.getDashboard('2026-06-01', '2026-06-30');

    expect(result.totalMaintenanceCosts).toBe(120);
    expect(result.averageCostPerTruck).toBe(60);
    expect(result.mostCostlyTruck).toMatchObject({
      plateNumber: 'ABC123',
      totalCost: 120,
    });
    expect(result.trucks[0]).toMatchObject({ flagged: true, totalCost: 120 });
    expect(result.trucks[0].records).toEqual([
      expect.objectContaining({
        id: 'work-1',
        mechanicName: 'Mechanic One',
        type: 'Oil Change',
        totalCost: 120,
      }),
    ]);
  });

  it('flags high-cost vehicles with three consecutive threshold-exceeding months as recurring candidates', async () => {
    prisma.maintenanceCostingSetting.findUnique.mockResolvedValue({
      threshold: { toNumber: () => 100 },
    });
    prisma.maintenanceSchedule.findMany.mockResolvedValue(
      ['2026-04-10', '2026-05-10', '2026-06-10'].map((day, index) => ({
        id: `work-${index}`,
        workOrderNumber: `WO-${index}`,
        vehicleId: 'ABC123',
        title: 'Preventive Maintenance',
        assignedMechanic: 'Mechanic One',
        completedAt: new Date(`${day}T04:00:00.000Z`),
        partsCost: null,
        laborCost: null,
        totalCost: { toNumber: () => 120 },
        workOrderProgress: null,
        assignedMechanicUser: { name: 'Mechanic One' },
      })),
    );

    const result = await service.getDashboard('2026-06-01', '2026-06-30');

    expect(result.trucks[0]).toMatchObject({
      totalCost: 120,
      flagged: true,
      recurringHighCost: true,
      records: [expect.objectContaining({ id: 'work-2' })],
    });
  });

  it('rejects an incomplete or reversed period', async () => {
    await expect(service.getDashboard('2026-05-01')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.getDashboard('2026-06-30', '2026-06-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a positive threshold and persists Admin attribution plus audit history', async () => {
    await expect(
      service.updateThreshold(0, {
        sub: 'admin-1',
        email: 'admin@example.invalid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();

    const tx = {
      maintenanceCostingSetting: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ threshold: { toNumber: () => 500 } }),
        upsert: jest.fn().mockResolvedValue({
          threshold: { toNumber: () => 750 },
          updatedAt: new Date('2026-06-01T00:00:00Z'),
        }),
      },
      maintenanceCostingThresholdAudit: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await service.updateThreshold(750, {
      sub: 'admin-1',
      email: 'admin@example.invalid',
    });

    expect(result.threshold).toBe(750);
    expect(tx.maintenanceCostingSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'default' },
        update: expect.objectContaining({
          updatedById: 'admin-1',
          updatedByEmail: 'admin@example.invalid',
        }),
      }),
    );
    expect(tx.maintenanceCostingThresholdAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'admin-1',
          previousThreshold: { toNumber: expect.any(Function) },
        }),
      }),
    );
  });

  it('exports a truck-scoped two-sheet workbook and audits export metadata only', async () => {
    prisma.maintenanceCostingSetting.findUnique.mockResolvedValue({
      threshold: { toNumber: () => 100 },
    });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      {
        id: 'work-1',
        workOrderNumber: 'WO-1',
        vehicleId: 'ABC123',
        title: 'Oil Change',
        assignedMechanic: 'Mechanic One',
        completedAt: new Date('2026-06-04T04:00:00.000Z'),
        partsCost: { toNumber: () => 80 },
        laborCost: { toNumber: () => 40 },
        totalCost: { toNumber: () => 120 },
        workOrderProgress: null,
      },
    ]);

    const buffer = await service.exportXlsx(
      '2026-06-01',
      '2026-06-30',
      'vehicle-1',
      { sub: 'admin-1', email: 'admin@example.invalid' },
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Cost Summary',
      'Completed Work',
    ]);
    expect(workbook.getWorksheet('Cost Summary')?.getCell('A7').value).toBe(
      'ABC123',
    );
    expect(workbook.getWorksheet('Cost Summary')?.getCell('E7').value).toBe(
      120,
    );
    expect(workbook.getWorksheet('Cost Summary')?.getCell('G7').value).toBe(
      'Yes',
    );
    expect(workbook.getWorksheet('Cost Summary')?.getCell('A8').value).toBe(
      null,
    );
    expect(workbook.getWorksheet('Completed Work')?.getCell('A7').value).toBe(
      'ABC123',
    );
    expect(workbook.getWorksheet('Completed Work')?.getCell('E7').value).toBe(
      'WO-1',
    );
    expect(workbook.getWorksheet('Completed Work')?.getCell('K7').value).toBe(
      120,
    );
    const workbookText = workbook.worksheets
      .flatMap((sheet) => sheet.getSheetValues())
      .flat()
      .join(' ');
    expect(workbookText).not.toMatch(/income|profit|revenue|repair|fuel/i);
    expect(prisma.maintenanceCostingExportAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'admin-1',
          actorEmail: 'admin@example.invalid',
          format: 'XLSX',
          fromDate: expect.any(Date),
          toDate: expect.any(Date),
          selectedTruckId: 'vehicle-1',
          selectedTruckPlate: 'ABC123',
        }),
      }),
    );
    expect(
      JSON.stringify(prisma.maintenanceCostingExportAudit.create.mock.calls[0]),
    ).not.toMatch(/partsCost|laborCost|totalCost|120/);
  });

  it('records PDF export scope without storing report contents', async () => {
    const result = await service.auditPdfExport(
      '2026-06-01',
      '2026-06-30',
      'vehicle-1',
      { sub: 'ops-1', email: 'ops@example.invalid' },
    );

    expect(result).toEqual({ recorded: true });
    expect(prisma.maintenanceCostingExportAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'ops-1',
          actorEmail: 'ops@example.invalid',
          format: 'PDF',
          selectedTruckId: 'vehicle-1',
          selectedTruckPlate: 'ABC123',
        }),
      }),
    );
    expect(
      JSON.stringify(prisma.maintenanceCostingExportAudit.create.mock.calls[0]),
    ).not.toMatch(/partsCost|laborCost|totalCost/);
  });
});
