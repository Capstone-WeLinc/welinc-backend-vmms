import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { VehiclesService } from './vehicles.service';

describe('VehiclesService maintenance defaults', () => {
  const vehicleId = '8da72728-b06e-4475-945e-2cf3c99a996e';
  const templateId = '210295aa-4097-47a3-b2e1-9c4c6a9c7d17';
  const vehicle = {
    id: vehicleId,
    plateNumber: 'ABC123',
    isActive: true,
    defaultMaintenanceIntervalKm: 5000,
    defaultMaintenanceBufferKm: 500,
  };
  const prisma = {
    $transaction: jest.fn(),
    vehicle: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    checklistTemplate: {
      findMany: jest.fn(),
    },
    vehicleMaintenanceDefault: {
      deleteMany: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const service = new VehiclesService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.vehicle.findFirst.mockResolvedValue(vehicle);
    prisma.checklistTemplate.findMany.mockResolvedValue([]);
    prisma.vehicle.update.mockResolvedValue(vehicle);
    prisma.vehicleMaintenanceDefault.deleteMany.mockResolvedValue({
      count: 0,
    });
    prisma.vehicleMaintenanceDefault.upsert.mockResolvedValue({});
  });

  it('returns vehicle defaults and configurable checklist categories', async () => {
    prisma.checklistTemplate.findMany.mockResolvedValue([
      {
        id: templateId,
        type: 'Scheduled service',
        vehicleDefaults: [{ intervalKm: 8000, bufferDistanceKm: 800 }],
      },
      {
        id: '98cb991e-328d-47f6-8c82-a0aa1da43021',
        type: 'Another service',
        vehicleDefaults: [],
      },
    ]);

    await expect(service.getMaintenanceDefaults(vehicleId)).resolves.toEqual({
      vehicleId,
      plateNumber: 'ABC123',
      baseIntervalKm: 5000,
      baseBufferDistanceKm: 500,
      categories: [
        {
          checklistTemplateId: templateId,
          type: 'Scheduled service',
          intervalKm: 8000,
          bufferDistanceKm: 800,
        },
        {
          checklistTemplateId: '98cb991e-328d-47f6-8c82-a0aa1da43021',
          type: 'Another service',
          intervalKm: null,
          bufferDistanceKm: null,
        },
      ],
    });
  });

  it('saves the base pair and replaces category overrides transactionally', async () => {
    prisma.checklistTemplate.findMany
      .mockResolvedValueOnce([{ id: templateId }])
      .mockResolvedValueOnce([
        {
          id: templateId,
          type: 'Scheduled service',
          vehicleDefaults: [{ intervalKm: 8000, bufferDistanceKm: 800 }],
        },
      ]);

    await service.updateMaintenanceDefaults(vehicleId, {
      baseIntervalKm: '5000',
      baseBufferDistanceKm: '500',
      categoryOverrides: [
        {
          checklistTemplateId: templateId,
          intervalKm: '8000',
          bufferDistanceKm: '800',
        },
      ],
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.vehicle.update).toHaveBeenCalledWith({
      where: { id: vehicleId },
      data: {
        defaultMaintenanceIntervalKm: 5000,
        defaultMaintenanceBufferKm: 500,
      },
    });
    expect(prisma.vehicleMaintenanceDefault.upsert).toHaveBeenCalledWith({
      where: {
        vehicleId_checklistTemplateId: {
          vehicleId,
          checklistTemplateId: templateId,
        },
      },
      create: {
        vehicleId,
        checklistTemplateId: templateId,
        intervalKm: 8000,
        bufferDistanceKm: 800,
      },
      update: { intervalKm: 8000, bufferDistanceKm: 800 },
    });
  });

  it('requires base interval and buffer to be set or cleared together', async () => {
    await expect(
      service.updateMaintenanceDefaults(vehicleId, {
        baseIntervalKm: '5000',
        baseBufferDistanceKm: '',
        categoryOverrides: [],
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'Set both base maintenance interval and buffer, or leave both blank.',
      ),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects category overrides outside the active configurable templates', async () => {
    await expect(
      service.updateMaintenanceDefaults(vehicleId, {
        baseIntervalKm: '',
        baseBufferDistanceKm: '',
        categoryOverrides: [
          {
            checklistTemplateId: templateId,
            intervalKm: '8000',
            bufferDistanceKm: '800',
          },
        ],
      }),
    ).rejects.toThrow(
      'Every category override must use an active checklist template.',
    );
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
  });
});
