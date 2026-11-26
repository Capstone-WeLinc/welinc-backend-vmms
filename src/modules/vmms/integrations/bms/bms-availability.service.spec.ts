import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma, VehicleStatus } from '@prisma/client';
import { BMS_AVAILABILITY_TOKENS } from '../../../../auth/verify';
import { PrismaService } from '../../../../shared/prisma.service';
import { BmsAvailabilityService } from './bms-availability.service';

const vehicleId = 'c4b5a2e8-59c4-4c18-8bda-97e8df63f1c0';
const occurredAt = new Date('2026-11-27T00:00:00.000Z');

describe('BmsAvailabilityService', () => {
  let module: TestingModule;
  let service: BmsAvailabilityService;
  let fetchMock: jest.SpyInstance;
  let transaction: {
    $queryRaw: jest.Mock;
    bmsVehicleAvailabilityEvent: {
      create: jest.Mock;
      findFirst: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let prisma: {
    $transaction: jest.Mock;
    bmsVehicleAvailabilityEvent: {
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let tokens: { withToken: jest.Mock };

  const event = (eventVersion: number) => ({
    eventId: `event-${eventVersion}`,
    vehicleId,
    eventVersion,
    status: VehicleStatus.UNDER_MAINTENANCE,
    occurredAt,
    attempts: 0,
    vehicle: { plateNumber: 'TGD 908' },
  });

  beforeEach(async () => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected BMS request.'));
    transaction = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      bmsVehicleAvailabilityEvent: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma = {
      $transaction: jest.fn((callback) => callback(transaction)),
      bmsVehicleAvailabilityEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    tokens = {
      withToken: jest.fn((callback: (token: string) => Promise<unknown>) =>
        callback('availability-service-token'),
      ),
    };

    module = await Test.createTestingModule({
      providers: [
        BmsAvailabilityService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('https://gateway.example.invalid/'),
          },
        },
        { provide: BMS_AVAILABILITY_TOKENS, useValue: tokens },
      ],
    }).compile();

    service = module.get(BmsAvailabilityService);
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await module.close();
  });

  it('records each status change with the persisted availability version', async () => {
    await service.recordStatusChange(
      transaction as unknown as Prisma.TransactionClient,
      {
        id: vehicleId,
        plateNumber: 'TGD 908',
        status: VehicleStatus.UNDER_MAINTENANCE,
        availabilityVersion: 4,
      },
    );

    expect(transaction.bmsVehicleAvailabilityEvent.create).toHaveBeenCalledWith(
      {
        data: {
          eventId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
          vehicleId,
          eventVersion: 4,
          status: VehicleStatus.UNDER_MAINTENANCE,
          occurredAt: expect.any(Date),
        },
      },
    );
  });

  it('refuses to record a status event without a positive version', async () => {
    await expect(
      service.recordStatusChange(
        transaction as unknown as Prisma.TransactionClient,
        {
          id: vehicleId,
          plateNumber: 'TGD 908',
          status: VehicleStatus.AVAILABLE,
          availabilityVersion: 0,
        },
      ),
    ).rejects.toThrow('Vehicle availability version must be positive.');

    expect(
      transaction.bmsVehicleAvailabilityEvent.create,
    ).not.toHaveBeenCalled();
  });

  it('sends the versioned payload and marks a successful event sent', async () => {
    prisma.bmsVehicleAvailabilityEvent.findMany.mockResolvedValue([event(4)]);
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

    await service.deliverPending();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://gateway.example.invalid/bms/integrations/vmms/vehicle-availability',
    );
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      Authorization: 'Bearer availability-service-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      eventId: 'event-4',
      eventVersion: 4,
      vmmsVehicleId: vehicleId,
      vehiclePlate: 'TGD 908',
      status: VehicleStatus.UNDER_MAINTENANCE,
      occurredAt: occurredAt.toISOString(),
    });
    expect(prisma.bmsVehicleAvailabilityEvent.updateMany).toHaveBeenCalledWith({
      where: { eventId: 'event-4', sentAt: null },
      data: { sentAt: expect.any(Date), lastErrorCode: null },
    });
  });

  it('backs off after failure and does not send a later version for that vehicle', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-27T00:00:00.000Z'));
    prisma.bmsVehicleAvailabilityEvent.findMany.mockResolvedValue([
      event(4),
      event(5),
    ]);
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await service.deliverPending();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      transaction.bmsVehicleAvailabilityEvent.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        eventId: 'event-4',
        sentAt: null,
        nextAttemptAt: { lte: new Date('2026-11-27T00:00:00.000Z') },
      },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: new Date('2026-11-27T00:00:00.000Z'),
        nextAttemptAt: new Date('2026-11-27T00:00:15.000Z'),
      },
    });
    expect(prisma.bmsVehicleAvailabilityEvent.updateMany).toHaveBeenCalledWith({
      where: { eventId: 'event-4', sentAt: null },
      data: {
        nextAttemptAt: new Date('2026-11-27T00:00:30.000Z'),
        lastErrorCode: 'http_503',
      },
    });
  });

  it('retries an event with the same id after the backoff', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-27T00:00:00.000Z'));
    prisma.bmsVehicleAvailabilityEvent.findMany
      .mockResolvedValueOnce([event(4)])
      .mockResolvedValueOnce([{ ...event(4), attempts: 1 }]);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    await service.deliverPending();
    jest.advanceTimersByTime(30_000);
    await service.deliverPending();

    const sentEventIds = fetchMock.mock.calls.map(
      ([, options]) => JSON.parse(options.body as string).eventId,
    );
    expect(sentEventIds).toEqual(['event-4', 'event-4']);
  });

  it('does not deliver a later version while an earlier event is pending', async () => {
    prisma.bmsVehicleAvailabilityEvent.findMany.mockResolvedValue([event(5)]);
    transaction.bmsVehicleAvailabilityEvent.findFirst.mockResolvedValue({
      eventId: 'event-4',
    });

    await service.deliverPending();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      transaction.bmsVehicleAvailabilityEvent.updateMany,
    ).not.toHaveBeenCalled();
  });
});
