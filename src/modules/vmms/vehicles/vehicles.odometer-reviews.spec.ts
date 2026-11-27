import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, VrmsRepairOdometerReviewStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { BmsAvailabilityService } from '../integrations/bms/bms-availability.service';
import { BmsFleetChangesService } from '../integrations/bms/bms-fleet-changes.service';
import { VehiclesService } from './vehicles.service';

const reviewId = 'c4b5a2e8-59c4-4c18-8bda-97e8df63f1c0';
const vehicleId = '23d53ff4-919c-4420-a7d3-83d077c2b93a';
const operationsActor = {
  sub: '8da72728-b06e-4475-945e-2cf3c99a996e',
  email: 'operations@example.test',
};

describe('VehiclesService VRMS odometer reviews', () => {
  const transaction = {
    vrmsRepairOdometerReview: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    vehicle: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    vehicleAuditLog: {
      createMany: jest.fn(),
    },
    maintenanceSchedule: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn(),
    vrmsRepairOdometerReview: {
      findMany: jest.fn(),
    },
  };
  const fleetChanges = { recordChange: jest.fn() };
  const service = new VehiclesService(
    prisma as unknown as PrismaService,
    {} as BmsAvailabilityService,
    fleetChanges as unknown as BmsFleetChangesService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (tx: Prisma.TransactionClient) => unknown) =>
        callback(transaction as unknown as Prisma.TransactionClient),
    );
    transaction.vrmsRepairOdometerReview.findUnique.mockResolvedValue({
      id: reviewId,
      vehicleId,
      serviceOdometerReading: 125,
      status: VrmsRepairOdometerReviewStatus.PENDING,
    });
    transaction.vrmsRepairOdometerReview.updateMany.mockResolvedValue({
      count: 1,
    });
    transaction.vehicle.findUnique
      .mockResolvedValueOnce({
        odometer: 100,
        isActive: true,
        deletedAt: null,
      })
      .mockResolvedValueOnce({
        id: vehicleId,
        plateNumber: 'TGD 908',
        odometer: 125,
        isActive: true,
        deletedAt: null,
        garage: null,
      });
    transaction.vehicle.updateMany.mockResolvedValue({ count: 1 });
    transaction.vehicleAuditLog.createMany.mockResolvedValue({ count: 1 });
    transaction.maintenanceSchedule.findMany.mockResolvedValue([]);
    fleetChanges.recordChange.mockResolvedValue(undefined);
  });

  it('returns a bounded, cursor-paginated pending queue with current master readings', async () => {
    const records = Array.from({ length: 51 }, (_, index) => ({
      id: `review-${index}`,
      repairTicketId: 'ticket-id',
      serviceOdometerReading: 45678,
      occurredAt: new Date('2026-11-27T00:00:00.000Z'),
      event: {
        repairTicketId: 'ticket-id',
        repairTicketNumber: 'VR-100',
        outsideShopName: 'North Shop',
      },
      vehicle: {
        id: vehicleId,
        plateNumber: 'TGD 908',
        odometer: 45000,
        isActive: false,
      },
    }));
    prisma.vrmsRepairOdometerReview.findMany.mockResolvedValue(records);

    const result = await service.findPendingVrmsOdometerReviews(reviewId);

    expect(prisma.vrmsRepairOdometerReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: VrmsRepairOdometerReviewStatus.PENDING },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 51,
        cursor: { id: reviewId },
        skip: 1,
      }),
    );
    expect(result.items).toHaveLength(50);
    expect(result.items[0]).toEqual({
      id: 'review-0',
      repairTicketId: 'ticket-id',
      repairTicketNumber: 'VR-100',
      outsideShopName: 'North Shop',
      vehicleId,
      plateNumber: 'TGD 908',
      currentOdometer: 45000,
      isActive: false,
      serviceOdometerReading: 45678,
      occurredAt: '2026-11-27T00:00:00.000Z',
    });
    expect(result.nextCursor).toBe('review-49');
  });

  it('confirms in the Operations odometer transaction and records the reviewer', async () => {
    await expect(
      service.confirmVrmsOdometerReview(reviewId, operationsActor),
    ).resolves.toEqual({
      id: reviewId,
      status: VrmsRepairOdometerReviewStatus.CONFIRMED,
    });

    expect(transaction.vehicle.updateMany).toHaveBeenCalledWith({
      where: {
        id: vehicleId,
        odometer: 100,
        isActive: true,
        deletedAt: null,
      },
      data: { odometer: 125 },
    });
    expect(transaction.vehicleAuditLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          vehicleId,
          userId: operationsActor.sub,
          email: operationsActor.email,
          action: 'ODOMETER_UPDATED',
          previousValue: '100',
          newValue: '125',
        }),
      ],
    });
    expect(
      transaction.vrmsRepairOdometerReview.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        id: reviewId,
        status: VrmsRepairOdometerReviewStatus.PENDING,
      },
      data: {
        status: VrmsRepairOdometerReviewStatus.CONFIRMED,
        reviewedAt: expect.any(Date),
        reviewedById: operationsActor.sub,
      },
    });
    expect(fleetChanges.recordChange).toHaveBeenCalled();
  });

  it('keeps a lower completed reading pending when Operations cannot confirm it', async () => {
    transaction.vrmsRepairOdometerReview.findUnique.mockResolvedValue({
      id: reviewId,
      vehicleId,
      serviceOdometerReading: 75,
      status: VrmsRepairOdometerReviewStatus.PENDING,
    });
    transaction.vehicle.findUnique.mockReset().mockResolvedValue({
      odometer: 100,
      isActive: true,
      deletedAt: null,
    });

    await expect(
      service.confirmVrmsOdometerReview(reviewId, operationsActor),
    ).rejects.toThrow(
      new BadRequestException(
        'Odometer cannot be lower than the current reading (100).',
      ),
    );

    expect(
      transaction.vrmsRepairOdometerReview.updateMany,
    ).not.toHaveBeenCalled();
    expect(transaction.vehicleAuditLog.createMany).not.toHaveBeenCalled();
  });

  it('dismisses without changing the master reading and records the reviewer', async () => {
    await expect(
      service.dismissVrmsOdometerReview(reviewId, operationsActor),
    ).resolves.toEqual({
      id: reviewId,
      status: VrmsRepairOdometerReviewStatus.DISMISSED,
    });

    expect(transaction.vehicle.findUnique).not.toHaveBeenCalled();
    expect(
      transaction.vrmsRepairOdometerReview.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        id: reviewId,
        status: VrmsRepairOdometerReviewStatus.PENDING,
      },
      data: {
        status: VrmsRepairOdometerReviewStatus.DISMISSED,
        reviewedAt: expect.any(Date),
        reviewedById: operationsActor.sub,
      },
    });
  });

  it('refuses a second decision for an already reviewed reading', async () => {
    transaction.vrmsRepairOdometerReview.findUnique.mockResolvedValue({
      id: reviewId,
      vehicleId,
      serviceOdometerReading: 125,
      status: VrmsRepairOdometerReviewStatus.DISMISSED,
    });

    await expect(
      service.confirmVrmsOdometerReview(reviewId, operationsActor),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(transaction.vehicle.findUnique).not.toHaveBeenCalled();
    expect(
      transaction.vrmsRepairOdometerReview.updateMany,
    ).not.toHaveBeenCalled();
  });
});
