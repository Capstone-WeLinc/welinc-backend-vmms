import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BMS_FLEET_CHANGE_TOKENS,
  VRMS_FLEET_CHANGE_TOKENS,
} from '../../../../auth/verify';
import { PrismaService } from '../../../../shared/prisma.service';
import { BmsFleetChangesService } from './bms-fleet-changes.service';

const event = {
  eventId: '4bf4627c-b22b-4754-83d9-aa0bf7a71b4a',
  entityType: 'VEHICLE',
  entityId: 'c4b5a2e8-59c4-4c18-8bda-97e8df63f1c0',
  changeType: 'VEHICLE_UPDATED',
  occurredAt: new Date('2026-11-27T00:00:00.000Z'),
  attempts: 0,
};

describe('BmsFleetChangesService', () => {
  let module: TestingModule;
  let service: BmsFleetChangesService;
  let fetchMock: jest.SpyInstance;
  let prisma: {
    bmsFleetChangeEvent: {
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let bmsTokens: { withToken: jest.Mock };
  let vrmsTokens: { withToken: jest.Mock };

  beforeEach(async () => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));
    prisma = {
      bmsFleetChangeEvent: {
        findMany: jest.fn().mockResolvedValue([event]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    bmsTokens = {
      withToken: jest.fn((callback: (token: string) => Promise<unknown>) =>
        callback('bms-service-token'),
      ),
    };
    vrmsTokens = {
      withToken: jest.fn((callback: (token: string) => Promise<unknown>) =>
        callback('vrms-service-token'),
      ),
    };

    module = await Test.createTestingModule({
      providers: [
        BmsFleetChangesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('https://gateway.example.invalid/'),
          },
        },
        { provide: BMS_FLEET_CHANGE_TOKENS, useValue: bmsTokens },
        { provide: VRMS_FLEET_CHANGE_TOKENS, useValue: vrmsTokens },
      ],
    }).compile();

    service = module.get(BmsFleetChangesService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await module.close();
  });

  it('sends the same invalidation to both systems and marks it sent after both accept', async () => {
    await service.deliverPending();

    expect(bmsTokens.withToken).toHaveBeenCalledTimes(1);
    expect(vrmsTokens.withToken).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.map(([url, options]) => ({
        url: String(url),
        authorization: options?.headers
          ? (options.headers as Record<string, string>).Authorization
          : null,
        body: JSON.parse(options?.body as string),
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          url: 'https://gateway.example.invalid/bms/integrations/vmms/fleet-changes',
          authorization: 'Bearer bms-service-token',
          body: {
            eventId: event.eventId,
            entityType: event.entityType,
            entityId: event.entityId,
            changeType: event.changeType,
            occurredAt: event.occurredAt.toISOString(),
          },
        },
        {
          url: 'https://gateway.example.invalid/vrms/integrations/vmms/fleet-changes',
          authorization: 'Bearer vrms-service-token',
          body: {
            eventId: event.eventId,
            entityType: event.entityType,
            entityId: event.entityId,
            changeType: event.changeType,
            occurredAt: event.occurredAt.toISOString(),
          },
        },
      ]),
    );
    expect(prisma.bmsFleetChangeEvent.updateMany).toHaveBeenLastCalledWith({
      where: { eventId: event.eventId, sentAt: null },
      data: { sentAt: expect.any(Date), lastErrorCode: null },
    });
  });

  it('retains the event for retry when VRMS has not accepted it', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        new Response(null, {
          status: url.includes('/vrms/') ? 503 : 202,
        }),
      ),
    );

    await service.deliverPending();

    expect(prisma.bmsFleetChangeEvent.updateMany).toHaveBeenLastCalledWith({
      where: { eventId: event.eventId, sentAt: null },
      data: {
        nextAttemptAt: expect.any(Date),
        lastErrorCode: 'vrms_http_503',
      },
    });
    expect(prisma.bmsFleetChangeEvent.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sentAt: expect.any(Date) }),
      }),
    );
  });
});
