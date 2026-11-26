import { ConflictException } from '@nestjs/common';
import {
  MaintenanceApprovalStatus,
  MaintenanceStatus,
  VehicleStatus,
  VmmsRepairReferralStatus,
  VrmsRepairEventType,
  VrmsRepairReferralEventType,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma.service';
import { MaintenanceSchedulesService } from '../../maintenance-schedules/maintenance-schedules.service';
import { BmsAvailabilityService } from '../bms/bms-availability.service';
import { VrmsRepairEventsService } from './vrms-repair-events.service';
import { VrmsRepairEventDto } from './vrms-repair-event.dto';

const eventId = 'c4b5a2e8-59c4-4c18-8bda-97e8df63f1c0';
const referralId = '5f90a0a9-7352-4e84-a972-52e27528d773';
const vehicleId = '23d53ff4-919c-4420-a7d3-83d077c2b93a';
const scheduleId = '96ac6f8e-a232-411d-80d8-1a26517d31e2';
const occurredAt = '2026-11-27T00:00:00.000Z';

describe('VrmsRepairEventsService referral outcomes', () => {
  let service: VrmsRepairEventsService;
  let prisma: { $transaction: jest.Mock };
  let transaction: {
    $queryRaw: jest.Mock;
    vrmsRepairReferralEventReceipt: {
      findUnique: jest.Mock;
      create: jest.Mock;
    };
    vmmsRepairReferral: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    maintenanceSchedule: {
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
    vehicle: { findUnique: jest.Mock };
  };

  const referral = {
    id: referralId,
    vehicleId,
    maintenanceScheduleId: scheduleId,
    status: VmmsRepairReferralStatus.SENT,
  };

  const event = {
    eventId,
    referralId,
    eventType: VrmsRepairReferralEventType.REJECTED,
    reason: '  Brake inspection failed  ',
    occurredAt,
  };

  beforeEach(() => {
    transaction = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      vrmsRepairReferralEventReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vmmsRepairReferral: {
        findUnique: jest.fn().mockResolvedValue(referral),
        findFirst: jest.fn().mockResolvedValue({ id: referralId }),
        update: jest.fn(),
      },
      maintenanceSchedule: {
        findUnique: jest.fn().mockResolvedValue({
          id: scheduleId,
          vehicleId: 'TGD 908',
          status: MaintenanceStatus.OVERDUE,
          approvalStatus: MaintenanceApprovalStatus.FOR_REPAIR,
          updatedAt: new Date('2026-11-26T00:00:00.000Z'),
          workOrderProgress: {
            overdueFromStatus: MaintenanceStatus.IN_PROGRESS,
            inspectionItems: [{ id: 'item-1', status: 'fail' }],
          },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({ plateNumber: 'TGD 908' }),
      },
    };
    prisma = {
      $transaction: jest.fn((callback) => callback(transaction)),
    };
    service = new VrmsRepairEventsService(
      prisma as unknown as PrismaService,
      {} as MaintenanceSchedulesService,
      {} as BmsAvailabilityService,
    );
  });

  it('rejects the referral and makes an identical replay idempotent', async () => {
    const result = await service.applyReferralOutcome(event);

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(transaction.maintenanceSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: scheduleId,
        updatedAt: new Date('2026-11-26T00:00:00.000Z'),
      },
      data: {
        status: MaintenanceStatus.IN_PROGRESS,
        approvalStatus: MaintenanceApprovalStatus.REJECTED,
        workOrderProgress: {
          inspectionItems: [{ id: 'item-1', status: 'fail' }],
          vrmsRejectionReason: 'Brake inspection failed',
          rejectionRemarks: 'Brake inspection failed',
        },
      },
    });
    expect(transaction.vmmsRepairReferral.update).toHaveBeenCalledWith({
      where: { id: referralId },
      data: {
        status: VmmsRepairReferralStatus.REJECTED,
        outcomeReason: 'Brake inspection failed',
        outcomeEventId: eventId,
        outcomeOccurredAt: new Date(occurredAt),
        nextAttemptAt: null,
        failedAt: null,
        lastErrorCode: null,
      },
    });
    expect(
      transaction.vrmsRepairReferralEventReceipt.create,
    ).toHaveBeenCalledWith({
      data: {
        eventId,
        referralId,
        eventType: VrmsRepairReferralEventType.REJECTED,
        reason: 'Brake inspection failed',
        occurredAt: new Date(occurredAt),
      },
    });

    transaction.vrmsRepairReferralEventReceipt.findUnique.mockResolvedValue({
      eventId,
      referralId,
      eventType: VrmsRepairReferralEventType.REJECTED,
      reason: 'Brake inspection failed',
      occurredAt: new Date(occurredAt),
    });

    await expect(service.applyReferralOutcome(event)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(transaction.maintenanceSchedule.updateMany).toHaveBeenCalledTimes(1);
    expect(transaction.vmmsRepairReferral.update).toHaveBeenCalledTimes(1);
  });

  it('rejects reusing a referral event ID with a different payload', async () => {
    transaction.vrmsRepairReferralEventReceipt.findUnique.mockResolvedValue({
      eventId,
      referralId,
      eventType: VrmsRepairReferralEventType.REJECTED,
      reason: 'Different reason',
      occurredAt: new Date(occurredAt),
    });

    await expect(service.applyReferralOutcome(event)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(transaction.vmmsRepairReferral.findUnique).not.toHaveBeenCalled();
    expect(transaction.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
  });
});

describe('VrmsRepairEventsService ticket acceptance', () => {
  it('links an accepted referral atomically when VRMS opens its repair ticket', async () => {
    const referralRow = {
      id: referralId,
      vehicleId,
      maintenanceScheduleId: scheduleId,
      status: VmmsRepairReferralStatus.SENT,
      repairTicketId: null,
      deliveredAt: null,
    };
    const ticketEvent = {
      eventId: '4bf4627c-b22b-4754-83d9-aa0bf7a71b4a',
      repairTicketId: 'ee3d6c66-1d30-4c38-9f31-1d8e13b78816',
      eventVersion: 1,
      eventType: VrmsRepairEventType.OPENED,
      vmmsVehicleId: vehicleId,
      maintenanceScheduleIds: [scheduleId],
      acceptedReferralIds: [referralId],
      occurredAt,
      repairTicketNumber: 'VR-100',
      repairStatus: 'OPEN',
    } satisfies VrmsRepairEventDto;
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      vrmsRepairEventReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vrmsRepairIntegrationState: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vmmsRepairReferral: {
        findMany: jest.fn().mockResolvedValue([referralRow]),
        update: jest.fn(),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: vehicleId,
          plateNumber: 'TGD 908',
          status: VehicleStatus.AVAILABLE,
          availabilityVersion: 1,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: vehicleId,
          plateNumber: 'TGD 908',
          status: VehicleStatus.UNDER_REPAIR,
          availabilityVersion: 2,
        }),
      },
      maintenanceSchedule: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: scheduleId,
            vehicleId: 'TGD 908',
            deletedAt: null,
            status: MaintenanceStatus.IN_PROGRESS,
            approvalStatus: MaintenanceApprovalStatus.FOR_REPAIR,
            workOrderProgress: {},
          },
        ]),
      },
      outsourcedProvider: { findFirst: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(transaction)),
    };
    const availability = { recordStatusChange: jest.fn() };
    const service = new VrmsRepairEventsService(
      prisma as unknown as PrismaService,
      {} as MaintenanceSchedulesService,
      availability as unknown as BmsAvailabilityService,
    );

    await expect(service.apply(ticketEvent)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      eventVersion: 1,
    });

    expect(transaction.vmmsRepairReferral.update).toHaveBeenCalledWith({
      where: { id: referralId },
      data: {
        status: VmmsRepairReferralStatus.ACCEPTED,
        repairTicketId: ticketEvent.repairTicketId,
        repairTicketNumber: 'VR-100',
        repairStatus: 'OPEN',
        outsideShopName: null,
        deliveredAt: expect.any(Date),
        lastErrorCode: null,
      },
    });
    expect(transaction.vrmsRepairIntegrationState.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repairTicketId: ticketEvent.repairTicketId,
        vehicleId,
        repairTicketNumber: 'VR-100',
        acceptedReferralIds: [referralId],
        maintenanceScheduleIds: [scheduleId],
      }),
    });
    expect(transaction.vehicle.updateMany).toHaveBeenCalledWith({
      where: {
        id: vehicleId,
        isActive: true,
        deletedAt: null,
        status: VehicleStatus.AVAILABLE,
      },
      data: {
        status: VehicleStatus.UNDER_REPAIR,
        availabilityVersion: { increment: 1 },
      },
    });
    expect(availability.recordStatusChange).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        id: vehicleId,
        status: VehicleStatus.UNDER_REPAIR,
        availabilityVersion: 2,
      }),
    );
    expect(transaction.vrmsRepairEventReceipt.create).toHaveBeenCalledTimes(1);
  });
});
