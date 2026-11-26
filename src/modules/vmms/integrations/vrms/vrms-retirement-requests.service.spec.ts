import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  VrmsRepairIntegrationStatus,
  VrmsRetirementDecision,
  VrmsRetirementRequestStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma.service';
import { BmsFleetChangesService } from '../bms/bms-fleet-changes.service';
import { VrmsRepairEventsService } from './vrms-repair-events.service';
import { VrmsRetirementRequestsService } from './vrms-retirement-requests.service';
import { VrmsRetirementRequestDto } from './vrms-retirement-request.dto';

const requestId = 'c4b5a2e8-59c4-4c18-8bda-97e8df63f1c0';
const eventId = '5f90a0a9-7352-4e84-a972-52e27528d773';
const vehicleId = '23d53ff4-919c-4420-a7d3-83d077c2b93a';
const repairTicketId = '96ac6f8e-a232-411d-80d8-1a26517d31e2';
const actor = {
  sub: 'c60d7310-2b44-42c8-8ff1-01f4e3cc6356',
  email: 'ops@example.invalid',
};

const retirementRequest = {
  eventId,
  requestId,
  vmmsVehicleId: vehicleId,
  repairTicketId,
  repairTicketNumber: 'VR-100',
  reason: 'Beyond economical repair',
  occurredAt: '2026-11-27T00:00:00.000Z',
} satisfies VrmsRetirementRequestDto;

function createService(
  prisma: Record<string, unknown>,
  repairEvents = { closeForRetirement: jest.fn() },
  fleetChanges = { recordChange: jest.fn() },
  tokens = {
    withToken: jest.fn((callback: (token: string) => Promise<unknown>) =>
      callback('retirement-token'),
    ),
  },
) {
  return new VrmsRetirementRequestsService(
    prisma as unknown as PrismaService,
    repairEvents as unknown as VrmsRepairEventsService,
    fleetChanges as unknown as BmsFleetChangesService,
    {
      get: jest.fn().mockReturnValue('https://gateway.example.invalid'),
    } as unknown as ConfigService,
    tokens as never,
  );
}

describe('VrmsRetirementRequestsService', () => {
  it('stores a normalized retirement request and accepts its identical replay', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRetirementRequest: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValue({
            requestId,
            vehicleId,
            repairTicketId,
            repairTicketNumber: 'VR-100',
            reason: 'Beyond economical repair',
            occurredAt: new Date(retirementRequest.occurredAt),
          }),
        create: jest.fn(),
      },
      vehicle: { findFirst: jest.fn().mockResolvedValue({ id: vehicleId }) },
      vrmsRepairIntegrationState: {
        findUnique: jest.fn().mockResolvedValue({
          vehicleId,
          repairTicketNumber: 'VR-100',
          status: VrmsRepairIntegrationStatus.OPEN,
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const service = createService(prisma);

    await expect(
      service.receive({
        ...retirementRequest,
        repairTicketNumber: ' VR-100 ',
        reason: ' Beyond economical repair ',
      }),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    expect(tx.vrmsRetirementRequest.create).toHaveBeenCalledWith({
      data: {
        eventId,
        requestId,
        vehicleId,
        repairTicketId,
        repairTicketNumber: 'VR-100',
        reason: 'Beyond economical repair',
        occurredAt: new Date(retirementRequest.occurredAt),
      },
    });

    await expect(service.receive(retirementRequest)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
  });

  it('requires a reason before a retirement request can be declined', async () => {
    const prisma = { $transaction: jest.fn() };
    const service = createService(prisma);

    await expect(
      service.decide(
        requestId,
        { decision: VrmsRetirementDecision.DECLINED },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects blank ticket numbers and malformed pagination parameters', async () => {
    const tx = {
      vrmsRetirementRequest: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };
    const service = createService(tx);

    await expect(
      service.receive({
        ...retirementRequest,
        repairTicketNumber: '   ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.pending('invalid-cursor', '10'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.pending(undefined, '1x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.vrmsRetirementRequest.findUnique).not.toHaveBeenCalled();
    expect(tx.vrmsRetirementRequest.findMany).not.toHaveBeenCalled();
  });

  it('persists a decline and queues its decision event atomically', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRetirementRequest: {
        findUnique: jest.fn().mockResolvedValue({
          requestId,
          vehicleId,
          repairTicketId,
          status: VrmsRetirementRequestStatus.PENDING,
        }),
        update: jest.fn(),
      },
      vrmsRetirementDecisionOutbox: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const service = createService(prisma);

    const result = await service.decide(
      requestId,
      {
        decision: VrmsRetirementDecision.DECLINED,
        reason: 'Repair remains feasible',
      },
      actor,
    );

    expect(result).toMatchObject({
      requestId,
      decision: VrmsRetirementDecision.DECLINED,
      reason: 'Repair remains feasible',
      deliveryEventId: expect.any(String),
      deliveryStatus: 'QUEUED',
    });
    expect(tx.vrmsRetirementRequest.update).toHaveBeenCalledWith({
      where: { requestId },
      data: {
        status: VrmsRetirementRequestStatus.DECLINED,
        decisionReason: 'Repair remains feasible',
        decidedById: actor.sub,
        decidedAt: expect.any(Date),
      },
    });
    expect(tx.vrmsRetirementDecisionOutbox.create).toHaveBeenCalledWith({
      data: {
        eventId: result.deliveryEventId,
        requestId,
        decision: VrmsRetirementDecision.DECLINED,
        reason: 'Repair remains feasible',
        occurredAt: expect.any(Date),
      },
    });
  });

  it('blocks approval while another VRMS repair remains open', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      vrmsRetirementRequest: {
        findUnique: jest.fn().mockResolvedValue({
          requestId,
          vehicleId,
          repairTicketId,
          status: VrmsRetirementRequestStatus.PENDING,
        }),
        update: jest.fn(),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: vehicleId,
          isActive: true,
        }),
      },
      vrmsRepairIntegrationState: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { repairTicketId },
            { repairTicketId: '4bf4627c-b22b-4754-83d9-aa0bf7a71b4a' },
          ]),
      },
      vrmsRetirementDecisionOutbox: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const repairEvents = { closeForRetirement: jest.fn() };
    const fleetChanges = { recordChange: jest.fn() };
    const service = createService(prisma, repairEvents, fleetChanges);

    await expect(
      service.decide(
        requestId,
        { decision: VrmsRetirementDecision.APPROVED },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repairEvents.closeForRetirement).not.toHaveBeenCalled();
    expect(tx.vrmsRetirementRequest.update).not.toHaveBeenCalled();
    expect(tx.vrmsRetirementDecisionOutbox.create).not.toHaveBeenCalled();
    expect(fleetChanges.recordChange).not.toHaveBeenCalled();
  });

  it('retries failed VRMS decision delivery through the outbox', async () => {
    const now = new Date('2026-11-27T00:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(now);
    const event = {
      eventId: '9c6f18ab-4b9e-4e31-bdf9-4c826a44ae6d',
      requestId,
      decision: VrmsRetirementDecision.DECLINED,
      reason: 'Repair remains feasible',
      occurredAt: now,
      attempts: 0,
    };
    const prisma = {
      vrmsRetirementDecisionOutbox: {
        findMany: jest.fn().mockResolvedValue([event]),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
      },
    };
    const tokens = {
      withToken: jest.fn((callback: (token: string) => Promise<unknown>) =>
        callback('retirement-token'),
      ),
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 503 }));
    const service = createService(prisma, undefined, undefined, tokens);

    try {
      await service.deliverPending();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://gateway.example.invalid/vrms/integrations/vmms/retirement-decisions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer retirement-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventId: event.eventId,
            requestId,
            decision: VrmsRetirementDecision.DECLINED,
            reason: 'Repair remains feasible',
            occurredAt: now.toISOString(),
          }),
        }),
      );
      expect(
        prisma.vrmsRetirementDecisionOutbox.updateMany,
      ).toHaveBeenLastCalledWith({
        where: { eventId: event.eventId, sentAt: null },
        data: {
          nextAttemptAt: new Date(now.getTime() + 30_000),
          lastErrorCode: 'http_503',
        },
      });
    } finally {
      fetchMock.mockRestore();
      jest.useRealTimers();
    }
  });
});
