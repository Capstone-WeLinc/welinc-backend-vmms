import { ConflictException } from '@nestjs/common';
import {
  MaintenanceApprovalStatus,
  MaintenanceStatus,
  VehicleStatus,
  VmmsRepairReferralSource,
  VmmsRepairReferralStatus,
  VrmsRepairEventType,
  VrmsRepairIntegrationStatus,
  VrmsRepairReferralEventType,
  VrmsRetirementRequestStatus,
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
    $executeRaw: jest.Mock;
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
      $executeRaw: jest.fn().mockResolvedValue(0),
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

  it('rejects a fuel-anomaly referral without mutating a maintenance schedule', async () => {
    transaction.vmmsRepairReferral.findUnique.mockResolvedValue({
      ...referral,
      source: VmmsRepairReferralSource.FUEL_ANOMALY,
      maintenanceScheduleId: null,
      fuelTransactionId: 'c60d7310-2b44-42c8-8ff1-01f4e3cc6356',
    });

    await expect(service.applyReferralOutcome(event)).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });

    expect(transaction.vmmsRepairReferral.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: referralId },
        data: expect.objectContaining({
          status: VmmsRepairReferralStatus.REJECTED,
          outcomeReason: 'Brake inspection failed',
        }),
      }),
    );
    expect(transaction.maintenanceSchedule.findUnique).not.toHaveBeenCalled();
    expect(transaction.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
  });
});

describe('VrmsRepairEventsService ticket acceptance', () => {
  it('ignores a lower event version without reading or mutating repair data', async () => {
    const repairTicketId = 'ee3d6c66-1d30-4c38-9f31-1d8e13b78816';
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRepairEventReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vrmsRepairIntegrationState: {
        findUnique: jest.fn().mockResolvedValue({
          repairTicketId,
          vehicleId,
          repairTicketNumber: 'VR-100',
          status: VrmsRepairIntegrationStatus.COMPLETED,
          lastEventVersion: 2,
        }),
      },
      vehicle: { findFirst: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(transaction)),
    };
    const service = new VrmsRepairEventsService(
      prisma as unknown as PrismaService,
      {} as MaintenanceSchedulesService,
      {} as BmsAvailabilityService,
    );
    const staleEvent = {
      eventId: '4bf4627c-b22b-4754-83d9-aa0bf7a71b4a',
      repairTicketId,
      eventVersion: 1,
      eventType: VrmsRepairEventType.STATUS_UPDATED,
      vmmsVehicleId: vehicleId,
      maintenanceScheduleIds: [],
      acceptedReferralIds: [],
      occurredAt,
      repairTicketNumber: 'VR-100',
      repairStatus: 'ASSIGNED',
    } satisfies VrmsRepairEventDto;

    await expect(service.apply(staleEvent)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });

    expect(transaction.vehicle.findFirst).not.toHaveBeenCalled();
    expect(transaction.vrmsRepairEventReceipt.create).not.toHaveBeenCalled();
  });

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
      serviceOdometerReading: 45678,
    } satisfies VrmsRepairEventDto;
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRepairEventReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vrmsRepairIntegrationState: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
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
      vrmsRepairOdometerReview: { create: jest.fn() },
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
    expect(transaction.vrmsRepairEventReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ serviceOdometerReading: 45678 }),
    });
    expect(transaction.vrmsRepairOdometerReview.create).not.toHaveBeenCalled();
  });

  it('creates a pending Operations review for a completed service reading', async () => {
    const repairTicketId = 'ee3d6c66-1d30-4c38-9f31-1d8e13b78816';
    const previousOccurredAt = new Date('2026-11-26T00:00:00.000Z');
    const schedule = {
      id: scheduleId,
      vehicleId: 'TGD 908',
      deletedAt: null,
      status: MaintenanceStatus.COMPLETED,
      approvalStatus: MaintenanceApprovalStatus.VERIFIED,
      workOrderProgress: {},
    };
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRepairEventReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vrmsRepairIntegrationState: {
        findUnique: jest.fn().mockResolvedValue({
          repairTicketId,
          vehicleId,
          repairTicketNumber: 'VR-100',
          repairStatus: 'OPEN',
          outsideShopName: null,
          status: VrmsRepairIntegrationStatus.OPEN,
          lastEventVersion: 1,
          maintenanceScheduleIds: [scheduleId],
          acceptedReferralIds: [],
          lastOccurredAt: previousOccurredAt,
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      vmmsRepairReferral: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: vehicleId,
          plateNumber: 'TGD 908',
          status: VehicleStatus.UNDER_REPAIR,
          availabilityVersion: 1,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: vehicleId,
          plateNumber: 'TGD 908',
          status: VehicleStatus.AVAILABLE,
          availabilityVersion: 2,
        }),
      },
      maintenanceSchedule: {
        findMany: jest.fn().mockResolvedValue([schedule]),
      },
      outsourcedProvider: { findFirst: jest.fn() },
      vrmsRepairOdometerReview: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(transaction)),
    };
    const maintenanceSchedules = {
      returnToChiefForFinalVerificationFromVrmsEvent: jest.fn(),
    };
    const availability = { recordStatusChange: jest.fn() };
    const service = new VrmsRepairEventsService(
      prisma as unknown as PrismaService,
      maintenanceSchedules as unknown as MaintenanceSchedulesService,
      availability as unknown as BmsAvailabilityService,
    );
    const completedEvent = {
      eventId: 'c942a653-2e44-4ee3-8d85-8e710558a614',
      repairTicketId,
      eventVersion: 2,
      eventType: VrmsRepairEventType.COMPLETED,
      vmmsVehicleId: vehicleId,
      maintenanceScheduleIds: [scheduleId],
      acceptedReferralIds: [],
      occurredAt,
      repairTicketNumber: 'VR-100',
      repairStatus: 'CLOSED',
      serviceOdometerReading: 45678,
    } satisfies VrmsRepairEventDto;

    await expect(service.apply(completedEvent)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      eventVersion: 2,
    });

    expect(
      maintenanceSchedules.returnToChiefForFinalVerificationFromVrmsEvent,
    ).toHaveBeenCalledWith(transaction, schedule);
    expect(transaction.vrmsRepairOdometerReview.create).toHaveBeenCalledWith({
      data: {
        eventId: completedEvent.eventId,
        vehicleId,
        serviceOdometerReading: 45678,
        occurredAt: new Date(occurredAt),
      },
    });
    expect(
      transaction.vrmsRepairEventReceipt.create.mock.invocationCallOrder[0],
    ).toBeLessThan(
      transaction.vrmsRepairOdometerReview.create.mock.invocationCallOrder[0],
    );
  });

  it('links a new referral to an existing ticket and preserves its schedule links', async () => {
    const existingScheduleId = '4da7c12f-2ac5-4db4-b532-e0a6b0bd6c69';
    const existingReferralId = '1cb7ce91-c4d0-41fb-a330-831f4702eeea';
    const repairTicketId = 'ee3d6c66-1d30-4c38-9f31-1d8e13b78816';
    const previousOccurredAt = new Date('2026-11-26T00:00:00.000Z');
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRepairEventReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vrmsRepairIntegrationState: {
        findUnique: jest.fn().mockResolvedValue({
          repairTicketId,
          vehicleId,
          repairTicketNumber: 'VR-100',
          repairStatus: 'OPEN',
          outsideShopName: null,
          status: VrmsRepairIntegrationStatus.OPEN,
          lastEventVersion: 1,
          maintenanceScheduleIds: [existingScheduleId],
          acceptedReferralIds: [existingReferralId],
          lastOccurredAt: previousOccurredAt,
        }),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      vmmsRepairReferral: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: existingReferralId,
            vehicleId,
            maintenanceScheduleId: existingScheduleId,
            status: VmmsRepairReferralStatus.ACCEPTED,
            repairTicketId,
            deliveredAt: previousOccurredAt,
          },
          {
            id: referralId,
            vehicleId,
            maintenanceScheduleId: scheduleId,
            status: VmmsRepairReferralStatus.SENT,
            repairTicketId: null,
            deliveredAt: null,
          },
        ]),
        update: jest.fn(),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: vehicleId,
          plateNumber: 'TGD 908',
        }),
      },
      maintenanceSchedule: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: existingScheduleId,
            vehicleId: 'TGD 908',
            deletedAt: null,
            status: MaintenanceStatus.IN_PROGRESS,
            approvalStatus: MaintenanceApprovalStatus.FOR_REPAIR,
            workOrderProgress: {},
          },
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
    const ticketEvent = {
      eventId: 'c942a653-2e44-4ee3-8d85-8e710558a614',
      repairTicketId,
      eventVersion: 2,
      eventType: VrmsRepairEventType.LINKS_UPDATED,
      vmmsVehicleId: vehicleId,
      maintenanceScheduleIds: [existingScheduleId, scheduleId],
      acceptedReferralIds: [existingReferralId, referralId],
      occurredAt,
      repairTicketNumber: 'VR-100',
      repairStatus: 'OPEN',
    } satisfies VrmsRepairEventDto;

    await expect(service.apply(ticketEvent)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      eventVersion: 2,
    });

    expect(transaction.vrmsRepairIntegrationState.update).toHaveBeenCalledWith({
      where: { repairTicketId },
      data: expect.objectContaining({
        repairTicketNumber: 'VR-100',
        repairStatus: 'OPEN',
        status: VrmsRepairIntegrationStatus.OPEN,
        lastEventVersion: 2,
        maintenanceScheduleIds: [existingScheduleId, scheduleId],
        acceptedReferralIds: [existingReferralId, referralId],
      }),
    });
    expect(transaction.vmmsRepairReferral.update).toHaveBeenCalledTimes(2);
    expect(transaction.vmmsRepairReferral.update).toHaveBeenCalledWith({
      where: { id: referralId },
      data: expect.objectContaining({
        status: VmmsRepairReferralStatus.ACCEPTED,
        repairTicketId,
        repairTicketNumber: 'VR-100',
        repairStatus: 'OPEN',
      }),
    });
    expect(transaction.maintenanceSchedule.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [existingScheduleId, scheduleId] },
        deletedAt: null,
      },
    });
    expect(availability.recordStatusChange).not.toHaveBeenCalled();
    expect(transaction.vrmsRepairEventReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repairTicketId,
        repairTicketNumber: 'VR-100',
        repairStatus: 'OPEN',
        maintenanceScheduleIds: [existingScheduleId, scheduleId],
        acceptedReferralIds: [existingReferralId, referralId],
      }),
    });
  });

  it('accepts a referral-only link update with a version gap after schedule changes state', async () => {
    const existingReferralId = '1cb7ce91-c4d0-41fb-a330-831f4702eeea';
    const repairTicketId = 'ee3d6c66-1d30-4c38-9f31-1d8e13b78816';
    const previousOccurredAt = new Date('2026-11-26T00:00:00.000Z');
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRepairEventReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vrmsRepairIntegrationState: {
        findUnique: jest.fn().mockResolvedValue({
          repairTicketId,
          vehicleId,
          repairTicketNumber: 'VR-100',
          repairStatus: 'OPEN',
          outsideShopName: null,
          status: VrmsRepairIntegrationStatus.OPEN,
          lastEventVersion: 1,
          maintenanceScheduleIds: [scheduleId],
          acceptedReferralIds: [existingReferralId],
          lastOccurredAt: previousOccurredAt,
        }),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      vmmsRepairReferral: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: existingReferralId,
            vehicleId,
            maintenanceScheduleId: scheduleId,
            status: VmmsRepairReferralStatus.ACCEPTED,
            repairTicketId,
            deliveredAt: previousOccurredAt,
          },
          {
            id: referralId,
            vehicleId,
            maintenanceScheduleId: scheduleId,
            status: VmmsRepairReferralStatus.SENT,
            repairTicketId: null,
            deliveredAt: null,
          },
        ]),
        update: jest.fn(),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: vehicleId,
          plateNumber: 'TGD 908',
        }),
      },
      maintenanceSchedule: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: scheduleId,
            vehicleId: 'TGD 908',
            deletedAt: null,
            status: MaintenanceStatus.COMPLETED,
            approvalStatus: MaintenanceApprovalStatus.VERIFIED,
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
    const ticketEvent = {
      eventId: 'c942a653-2e44-4ee3-8d85-8e710558a614',
      repairTicketId,
      eventVersion: 3,
      eventType: VrmsRepairEventType.LINKS_UPDATED,
      vmmsVehicleId: vehicleId,
      maintenanceScheduleIds: [scheduleId],
      acceptedReferralIds: [existingReferralId, referralId],
      occurredAt,
      repairTicketNumber: 'VR-100',
      repairStatus: 'OPEN',
    } satisfies VrmsRepairEventDto;

    await expect(service.apply(ticketEvent)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      eventVersion: 3,
    });

    expect(transaction.vrmsRepairIntegrationState.update).toHaveBeenCalledWith({
      where: { repairTicketId },
      data: expect.objectContaining({
        lastEventVersion: 3,
        maintenanceScheduleIds: [scheduleId],
        acceptedReferralIds: [existingReferralId, referralId],
      }),
    });
    expect(transaction.vmmsRepairReferral.update).toHaveBeenCalledWith({
      where: { id: referralId },
      data: expect.objectContaining({
        status: VmmsRepairReferralStatus.ACCEPTED,
        repairTicketId,
        repairTicketNumber: 'VR-100',
        repairStatus: 'OPEN',
      }),
    });
    expect(availability.recordStatusChange).not.toHaveBeenCalled();
    expect(transaction.vrmsRepairEventReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: VrmsRepairEventType.LINKS_UPDATED,
        maintenanceScheduleIds: [scheduleId],
        acceptedReferralIds: [existingReferralId, referralId],
      }),
    });
  });

  it('accepts a fuel-anomaly referral on an opened repair without schedule links', async () => {
    const repairTicketId = 'c0d0b760-0de6-4d61-9a9d-bcf2db46703a';
    const fuelTransactionId = 'c60d7310-2b44-42c8-8ff1-01f4e3cc6356';
    const fuelReferralId = '9c6f18ab-4b9e-4e31-bdf9-4c826a44ae6d';
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRepairEventReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vrmsRepairIntegrationState: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
      vmmsRepairReferral: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: fuelReferralId,
            vehicleId,
            source: VmmsRepairReferralSource.FUEL_ANOMALY,
            maintenanceScheduleId: null,
            fuelTransactionId,
            status: VmmsRepairReferralStatus.SENT,
            repairTicketId: null,
            deliveredAt: null,
          },
        ]),
        update: jest.fn(),
      },
      fuelFillUp: {
        findUnique: jest.fn().mockResolvedValue({ vehicleId }),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: vehicleId,
          plateNumber: 'TGD 908',
          status: VehicleStatus.UNDER_REPAIR,
          availabilityVersion: 1,
        }),
      },
      maintenanceSchedule: { findMany: jest.fn() },
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
    const ticketEvent = {
      eventId: '91d69d7f-6085-4e80-a59f-3f242bf4be8f',
      repairTicketId,
      eventVersion: 1,
      eventType: VrmsRepairEventType.OPENED,
      vmmsVehicleId: vehicleId,
      maintenanceScheduleIds: [],
      acceptedReferralIds: [fuelReferralId],
      occurredAt,
      repairTicketNumber: 'VR-FUEL-100',
      repairStatus: 'OPEN',
    } satisfies VrmsRepairEventDto;

    await expect(service.apply(ticketEvent)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      eventVersion: 1,
    });

    expect(transaction.fuelFillUp.findUnique).toHaveBeenCalledWith({
      where: { id: fuelTransactionId },
      select: { vehicleId: true },
    });
    expect(transaction.vmmsRepairReferral.update).toHaveBeenCalledWith({
      where: { id: fuelReferralId },
      data: expect.objectContaining({
        status: VmmsRepairReferralStatus.ACCEPTED,
        repairTicketId,
        repairTicketNumber: 'VR-FUEL-100',
      }),
    });
    expect(transaction.maintenanceSchedule.findMany).not.toHaveBeenCalled();
    expect(availability.recordStatusChange).not.toHaveBeenCalled();
  });

  it('allows the replacement repair to open after Operations declines retirement', async () => {
    const previousTicketId = 'c0d0b760-0de6-4d61-9a9d-bcf2db46703a';
    const replacementTicketId = '4bf4627c-b22b-4754-83d9-aa0bf7a71b4a';
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRepairEventReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vrmsRepairIntegrationState: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([{ repairTicketId: previousTicketId }]),
        create: jest.fn(),
      },
      vrmsRetirementRequest: {
        findUnique: jest.fn().mockResolvedValue({
          vehicleId,
          status: VrmsRetirementRequestStatus.DECLINED,
        }),
      },
      vmmsRepairReferral: { findMany: jest.fn() },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: vehicleId,
          plateNumber: 'TGD 908',
          status: VehicleStatus.UNDER_REPAIR,
          availabilityVersion: 1,
        }),
      },
      maintenanceSchedule: { findMany: jest.fn() },
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
    const ticketEvent = {
      eventId: '91d69d7f-6085-4e80-a59f-3f242bf4be8f',
      repairTicketId: replacementTicketId,
      eventVersion: 1,
      eventType: VrmsRepairEventType.OPENED,
      vmmsVehicleId: vehicleId,
      maintenanceScheduleIds: [],
      acceptedReferralIds: [],
      occurredAt,
      repairTicketNumber: 'VR-NEW-100',
      repairStatus: 'OPEN',
    } satisfies VrmsRepairEventDto;

    await expect(service.apply(ticketEvent)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      eventVersion: 1,
    });
    expect(transaction.vrmsRepairIntegrationState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          repairTicketId: replacementTicketId,
          vehicleId,
          status: VrmsRepairIntegrationStatus.OPEN,
        }),
      }),
    );
    expect(transaction.vrmsRetirementRequest.findUnique).toHaveBeenCalledWith({
      where: { repairTicketId: previousTicketId },
      select: { vehicleId: true, status: true },
    });
  });
});
