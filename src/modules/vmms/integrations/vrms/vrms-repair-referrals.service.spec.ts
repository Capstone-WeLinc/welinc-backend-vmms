import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  MaintenanceSchedule,
  Prisma,
  VmmsRepairReferralStatus,
} from '@prisma/client';
import { VRMS_REFERRAL_TOKENS } from '../../../../auth/verify';
import { PrismaService } from '../../../../shared/prisma.service';
import { VrmsRepairReferralsService } from './vrms-repair-referrals.service';

const referralId = 'c4b5a2e8-59c4-4c18-8bda-97e8df63f1c0';
const vehicleId = '5f90a0a9-7352-4e84-a972-52e27528d773';
const scheduleId = '23d53ff4-919c-4420-a7d3-83d077c2b93a';
const gatewayUrl = 'https://gateway.example.invalid';

describe('VrmsRepairReferralsService', () => {
  let module: TestingModule;
  let service: VrmsRepairReferralsService;
  let fetchMock: jest.SpyInstance;
  let prisma: {
    vmmsRepairReferral: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    vehicle: { findFirst: jest.Mock };
  };
  let tokens: { withToken: jest.Mock };

  const schedule = {
    id: scheduleId,
    vehicleId: 'TGD 908',
    workOrderNumber: 'MLG-20261127-0001',
  } as MaintenanceSchedule;

  const payload = {
    referralId,
    vmmsVehicleId: vehicleId,
    vehiclePlate: 'TGD 908',
    maintenanceScheduleId: scheduleId,
    workOrderNumber: 'MLG-20261127-0001',
    odometerReading: 12345,
    findings: [
      {
        checklistItemId: 'item-1',
        label: 'Brake inspection',
        note: 'Wear beyond limits',
      },
    ],
    chiefMechanicRemarks: 'Refer to repair',
  };

  beforeEach(async () => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected VRMS request.'));
    prisma = {
      vmmsRepairReferral: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      vehicle: { findFirst: jest.fn() },
    };
    tokens = {
      withToken: jest.fn((callback: (token: string) => Promise<unknown>) =>
        callback('referral-service-token'),
      ),
    };

    module = await Test.createTestingModule({
      providers: [
        VrmsRepairReferralsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'SUITE_GATEWAY_INTERNAL_URL' ? `${gatewayUrl}/` : 24,
            ),
          },
        },
        { provide: VRMS_REFERRAL_TOKENS, useValue: tokens },
      ],
    }).compile();

    service = module.get(VrmsRepairReferralsService);
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await module.close();
  });

  it('creates one referral with failed findings and the work-order odometer', async () => {
    const tx = {
      vmmsRepairReferral: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: vehicleId,
          plateNumber: 'TGD 908',
          odometer: 12000,
        }),
      },
    };

    const result = await service.createFromWorkOrder(
      tx as unknown as Prisma.TransactionClient,
      schedule,
      {
        serviceOdometerReading: 12345,
        inspectorRemarks: '  Refer to repair  ',
        inspectionItems: [
          {
            id: 'item-1',
            label: 'Brake inspection',
            status: 'fail',
            note: 'Wear beyond limits',
          },
          {
            id: 'item-2',
            label: 'Lights',
            status: 'pass',
            note: '',
          },
        ],
      },
    );

    expect(result).toEqual({ id: expect.any(String), created: true });
    const createCall = tx.vmmsRepairReferral.create.mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      id: result.id,
      vehicleId,
      maintenanceScheduleId: scheduleId,
      workOrderNumber: schedule.workOrderNumber,
      status: VmmsRepairReferralStatus.QUEUED,
    });
    expect(createCall.data.requestPayload).toEqual({
      ...payload,
      referralId: result.id,
    });
  });

  it('returns an existing pending referral instead of creating a duplicate', async () => {
    const tx = {
      vmmsRepairReferral: {
        findFirst: jest.fn().mockResolvedValue({ id: referralId }),
        create: jest.fn(),
      },
      vehicle: { findFirst: jest.fn() },
    };

    await expect(
      service.createFromWorkOrder(
        tx as unknown as Prisma.TransactionClient,
        schedule,
        {},
      ),
    ).resolves.toEqual({ id: referralId, created: false });

    expect(tx.vehicle.findFirst).not.toHaveBeenCalled();
    expect(tx.vmmsRepairReferral.create).not.toHaveBeenCalled();
  });

  it('does not queue a referral without a failed inspection finding', async () => {
    const tx = {
      vmmsRepairReferral: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: vehicleId,
          plateNumber: 'TGD 908',
          odometer: 12000,
        }),
      },
    };

    await expect(
      service.createFromWorkOrder(
        tx as unknown as Prisma.TransactionClient,
        schedule,
        { inspectionItems: [{ id: 'item-1', status: 'pass' }] },
      ),
    ).rejects.toThrow(
      'Mark at least one inspection item as failed before referring the work order.',
    );

    expect(tx.vmmsRepairReferral.create).not.toHaveBeenCalled();
  });

  it('sends the stable referral payload and marks a 202 response as sent', async () => {
    const now = new Date();
    prisma.vmmsRepairReferral.findUnique.mockResolvedValue({
      id: referralId,
      requestPayload: payload,
      status: VmmsRepairReferralStatus.QUEUED,
      attempts: 0,
      attemptWindowStartedAt: new Date(now.getTime() - 60_000),
      nextAttemptAt: new Date(now.getTime() - 1_000),
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

    await service.deliverOne(referralId);

    expect(fetchMock).toHaveBeenCalledWith(
      `${gatewayUrl}/vrms/integrations/vmms/repair-referrals`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer referral-service-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': referralId,
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(prisma.vmmsRepairReferral.updateMany).toHaveBeenLastCalledWith({
      where: { id: referralId, status: VmmsRepairReferralStatus.QUEUED },
      data: {
        status: VmmsRepairReferralStatus.SENT,
        deliveredAt: expect.any(Date),
        nextAttemptAt: null,
        lastErrorCode: null,
      },
    });
  });

  it('backs off after a retryable VRMS response', async () => {
    const now = new Date('2026-11-27T00:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(now);
    prisma.vmmsRepairReferral.findUnique.mockResolvedValue({
      id: referralId,
      requestPayload: payload,
      status: VmmsRepairReferralStatus.QUEUED,
      attempts: 0,
      attemptWindowStartedAt: new Date(now.getTime() - 60_000),
      nextAttemptAt: new Date(now.getTime() - 1_000),
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await service.deliverOne(referralId);

    expect(prisma.vmmsRepairReferral.updateMany).toHaveBeenLastCalledWith({
      where: { id: referralId, status: VmmsRepairReferralStatus.QUEUED },
      data: {
        nextAttemptAt: new Date(now.getTime() + 30_000),
        lastErrorCode: 'http_503',
      },
    });
  });

  it('manually retries a failed referral with its original idempotency key', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-27T00:00:00.000Z'));
    prisma.vmmsRepairReferral.findUnique
      .mockResolvedValueOnce({
        id: referralId,
        status: VmmsRepairReferralStatus.FAILED,
      })
      .mockResolvedValueOnce({
        id: referralId,
        requestPayload: payload,
        status: VmmsRepairReferralStatus.QUEUED,
        attempts: 0,
        attemptWindowStartedAt: new Date('2026-11-27T00:00:00.000Z'),
        nextAttemptAt: new Date('2026-11-27T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: referralId,
        status: VmmsRepairReferralStatus.SENT,
      });
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

    const result = await service.retryFailed(referralId);

    expect(result).toMatchObject({
      id: referralId,
      status: VmmsRepairReferralStatus.SENT,
    });
    expect(prisma.vmmsRepairReferral.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: referralId, status: VmmsRepairReferralStatus.FAILED },
      data: {
        status: VmmsRepairReferralStatus.QUEUED,
        attemptWindowStartedAt: new Date('2026-11-27T00:00:00.000Z'),
        nextAttemptAt: new Date('2026-11-27T00:00:00.000Z'),
        attempts: 0,
        failedAt: null,
        lastErrorCode: null,
        manualRetryCount: { increment: 1 },
      },
    });
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe(
      referralId,
    );
  });
});
