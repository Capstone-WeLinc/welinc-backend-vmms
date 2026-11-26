import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  VRMS_HISTORY_TOKENS,
  VRMS_STATUS_TOKENS,
} from '../../../../auth/verify';
import { PrismaService } from '../../../../shared/prisma.service';
import { ScheduleActor } from '../../maintenance-schedules/schedule-access';
import { VrmsRepairReadsService } from './vrms-repair-reads.service';

const vehicleId = 'c4b5a2e8-59c4-4c18-8bda-97e8df63f1c0';
const scheduleId = '5f90a0a9-7352-4e84-a972-52e27528d773';
const repairTicketId = '23d53ff4-919c-4420-a7d3-83d077c2b93a';

function actor(role: string): ScheduleActor {
  return {
    sub: 'user-123',
    name: 'Test User',
    email: 'test@example.invalid',
    roles: [{ system: 'VMMS', role }],
  };
}

describe('VrmsRepairReadsService', () => {
  let module: TestingModule;
  let service: VrmsRepairReadsService;
  let fetchMock: jest.SpyInstance;
  let prisma: {
    maintenanceSchedule: { findFirst: jest.Mock };
    vmmsRepairReferral: { findFirst: jest.Mock };
    vrmsRepairIntegrationState: { findFirst: jest.Mock };
    vehicle: { findFirst: jest.Mock };
  };
  let statusTokens: { withToken: jest.Mock };
  let historyTokens: { withToken: jest.Mock };

  beforeEach(async () => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected VRMS request.'));
    prisma = {
      maintenanceSchedule: { findFirst: jest.fn() },
      vmmsRepairReferral: { findFirst: jest.fn() },
      vrmsRepairIntegrationState: { findFirst: jest.fn() },
      vehicle: { findFirst: jest.fn() },
    };
    statusTokens = {
      withToken: jest.fn((callback: (token: string) => Promise<unknown>) =>
        callback('status-service-token'),
      ),
    };
    historyTokens = {
      withToken: jest.fn((callback: (token: string) => Promise<unknown>) =>
        callback('history-service-token'),
      ),
    };
    prisma.vehicle.findFirst.mockResolvedValue({ id: vehicleId });

    module = await Test.createTestingModule({
      providers: [
        VrmsRepairReadsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('https://gateway.example.invalid/'),
          },
        },
        { provide: VRMS_STATUS_TOKENS, useValue: statusTokens },
        { provide: VRMS_HISTORY_TOKENS, useValue: historyTokens },
      ],
    }).compile();

    service = module.get(VrmsRepairReadsService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await module.close();
  });

  it.each(['ADMIN', 'OPERATIONS', 'CHIEF_MECHANIC'])(
    'returns repair costs to %s',
    async (role) => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
              { repairTicketNumber: 'VR-100', totalRepairCost: '1250.50' },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      );

      const result = await service.readVehicleHistory(
        vehicleId,
        actor(role),
        undefined,
        undefined,
      );

      expect(result.items[0]).toHaveProperty('totalRepairCost', 1250.5);
    },
  );

  it('omits repair costs for Mechanics and forwards bounded pagination', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              repairTicketNumber: 'VR-100',
              issues: [{ label: 'Brake wear' }],
              partsUsed: ['Brake pads'],
              repairPersonnel: [{ name: 'Technician' }],
              totalRepairCost: 1250.5,
            },
          ],
          nextCursor: 'next-page',
        }),
        { status: 200 },
      ),
    );

    const result = await service.readVehicleHistory(
      vehicleId,
      actor('MECHANIC'),
      'cursor/one',
      '25',
    );

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.pathname).toBe(
      `/vrms/integrations/vmms/vehicles/${vehicleId}/repair-history`,
    );
    expect(requestUrl.searchParams.get('limit')).toBe('25');
    expect(requestUrl.searchParams.get('cursor')).toBe('cursor/one');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      Authorization: 'Bearer history-service-token',
    });
    expect(result).toEqual({
      items: [
        {
          repairTicketNumber: 'VR-100',
          openedAt: null,
          closedAt: null,
          issues: ['Brake wear'],
          partsUsed: ['Brake pads'],
          repairPersonnel: ['Technician'],
          provider: null,
        },
      ],
      nextCursor: 'next-page',
    });
    expect(result.items[0]).not.toHaveProperty('totalRepairCost');
  });

  it('rejects invalid page sizes before calling VRMS', async () => {
    await expect(
      service.readVehicleHistory(vehicleId, actor('ADMIN'), undefined, '101'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a fresh ticket status for an assigned work order', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ id: scheduleId });
    prisma.vmmsRepairReferral.findFirst.mockResolvedValue({
      id: 'referral-123',
      status: 'ACCEPTED',
      repairTicketId,
      repairTicketNumber: 'VR-200',
      repairStatus: 'IN_PROGRESS',
      outsideShopName: null,
      outcomeReason: null,
      lastErrorCode: null,
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          repairTicketId,
          repairTicketNumber: 'VR-200',
          status: 'OUTSOURCED',
          outsideShopName: 'Demo Repair Shop',
        }),
        { status: 200 },
      ),
    );

    const result = await service.readWorkOrderStatus(
      scheduleId,
      actor('MECHANIC'),
    );

    expect(prisma.maintenanceSchedule.findFirst).toHaveBeenCalledWith({
      where: {
        id: scheduleId,
        deletedAt: null,
        assignedMechanicId: 'user-123',
      },
      select: { id: true },
    });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      Authorization: 'Bearer status-service-token',
    });
    expect(result.repairTicket).toEqual({
      repairTicketId,
      repairTicketNumber: 'VR-200',
      status: 'OUTSOURCED',
      outsideShopName: 'Demo Repair Shop',
    });
  });

  it('does not expose ticket status for an unassigned work order', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue(null);

    await expect(
      service.readWorkOrderStatus(scheduleId, actor('MECHANIC')),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an explicit unavailable error when VRMS is unavailable', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      service.readVehicleHistory(
        vehicleId,
        actor('OPERATIONS'),
        undefined,
        '50',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not call VRMS for inactive or missing vehicles', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(null);

    await expect(
      service.readVehicleHistory(vehicleId, actor('ADMIN'), undefined, '50'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
