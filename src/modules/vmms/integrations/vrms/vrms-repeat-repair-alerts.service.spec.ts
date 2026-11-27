import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma.service';
import { VrmsRepeatRepairAlertsService } from './vrms-repeat-repair-alerts.service';
import { VrmsRepeatRepairAlertDto } from './vrms-repeat-repair-alert.dto';

const event = {
  eventId: 'c4b5a2e8-59c4-4c18-8bda-97e8df63f1c0',
  vmmsVehicleId: '5f90a0a9-7352-4e84-a972-52e27528d773',
  category: '  Brake system  ',
  repairTicketNumbers: [' VR-100 ', 'VR-101'],
  windowDays: 90,
  count: 2,
  occurredAt: '2026-11-27T00:00:00.000Z',
} satisfies VrmsRepeatRepairAlertDto;

describe('VrmsRepeatRepairAlertsService', () => {
  const alert = {
    eventId: event.eventId,
    vehicleId: event.vmmsVehicleId,
    category: 'Brake system',
    repairTicketNumbers: ['VR-100', 'VR-101'],
    windowDays: 90,
    count: 2,
    occurredAt: new Date(event.occurredAt),
  };
  let transaction: {
    $executeRaw: jest.Mock;
    vrmsRepeatRepairAlert: { findUnique: jest.Mock; create: jest.Mock };
    vehicle: { findFirst: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    vrmsRepeatRepairAlert: { findUnique: jest.Mock; findMany: jest.Mock };
  };
  let service: VrmsRepeatRepairAlertsService;

  beforeEach(() => {
    transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRepeatRepairAlert: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({ id: event.vmmsVehicleId }),
      },
    };
    prisma = {
      $transaction: jest.fn((callback) => callback(transaction)),
      vrmsRepeatRepairAlert: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };
    service = new VrmsRepeatRepairAlertsService(
      prisma as unknown as PrismaService,
    );
  });

  it('stores normalized repeat-repair alert data', async () => {
    await expect(service.receive(event)).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });

    expect(transaction.vrmsRepeatRepairAlert.create).toHaveBeenCalledWith({
      data: {
        eventId: event.eventId,
        vehicleId: event.vmmsVehicleId,
        category: 'Brake system',
        repairTicketNumbers: ['VR-100', 'VR-101'],
        windowDays: 90,
        count: 2,
        occurredAt: new Date(event.occurredAt),
      },
    });
  });

  it('accepts an identical replay and rejects a conflicting event ID replay', async () => {
    transaction.vrmsRepeatRepairAlert.findUnique.mockResolvedValue(alert);

    await expect(service.receive(event)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
    await expect(
      service.receive({ ...event, count: 3 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.vrmsRepeatRepairAlert.create).not.toHaveBeenCalled();
  });

  it('returns a cursor page and rejects invalid limits', async () => {
    const olderAlert = {
      ...alert,
      eventId: '9c6f18ab-4b9e-4e31-bdf9-4c826a44ae6d',
      occurredAt: new Date('2026-11-26T00:00:00.000Z'),
      vehicle: { plateNumber: 'TGD 908' },
    };
    prisma.vrmsRepeatRepairAlert.findMany.mockResolvedValue([
      {
        ...alert,
        vehicle: { plateNumber: 'TGD 908' },
      },
      olderAlert,
    ]);

    await expect(service.list(undefined, '1')).resolves.toEqual({
      items: [
        {
          eventId: event.eventId,
          vmmsVehicleId: event.vmmsVehicleId,
          vehiclePlate: 'TGD 908',
          category: 'Brake system',
          repairTicketNumbers: ['VR-100', 'VR-101'],
          windowDays: 90,
          count: 2,
          occurredAt: event.occurredAt,
        },
      ],
      nextCursor: event.eventId,
    });
    await expect(service.list(undefined, '0')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.list(undefined, '1x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.list('invalid-cursor', '10')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects category and ticket numbers that become blank after trimming', async () => {
    await expect(
      service.receive({
        ...event,
        category: '   ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.receive({
        ...event,
        repairTicketNumbers: ['   '],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
