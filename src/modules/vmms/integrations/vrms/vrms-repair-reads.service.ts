import {
  BadRequestException,
  BadGatewayException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../config/env';
import {
  ServiceTokenClient,
  VRMS_HISTORY_TOKENS,
  VRMS_STATUS_TOKENS,
} from '../../../../auth/verify';
import { PrismaService } from '../../../../shared/prisma.service';
import { ScheduleActor, scheduleScope } from '../../maintenance-schedules/schedule-access';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_PAGE_SIZE = 100;
const repairStatuses = new Set([
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
  'OUTSOURCED',
  'FOR_VERIFICATION',
  'CLOSED',
  'CANCELLED',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (!isRecord(item)) return [];
    for (const key of ['label', 'name', 'description', 'title']) {
      const text = item[key];
      if (typeof text === 'string') return [text];
    }
    return [];
  });
}

@Injectable()
export class VrmsRepairReadsService {
  private readonly gatewayUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    @Inject(VRMS_STATUS_TOKENS)
    private readonly statusTokens: ServiceTokenClient,
    @Inject(VRMS_HISTORY_TOKENS)
    private readonly historyTokens: ServiceTokenClient,
  ) {
    this.gatewayUrl = config
      .get('SUITE_GATEWAY_INTERNAL_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  async readWorkOrderStatus(scheduleId: string, actor: ScheduleActor) {
    const schedule = await this.prisma.maintenanceSchedule.findFirst({
      where: {
        id: scheduleId,
        deletedAt: null,
        ...scheduleScope(actor),
      },
      select: { id: true },
    });
    if (!schedule) {
      throw new ForbiddenException('This work order is not assigned to you.');
    }

    const referral = await this.prisma.vmmsRepairReferral.findFirst({
      where: { maintenanceScheduleId: scheduleId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        repairTicketId: true,
        repairTicketNumber: true,
        repairStatus: true,
        outsideShopName: true,
        outcomeReason: true,
        lastErrorCode: true,
      },
    });
    let repairTicketId = referral?.repairTicketId ?? null;
    if (!repairTicketId) {
      const state = await this.prisma.vrmsRepairIntegrationState.findFirst({
        where: {
          maintenanceScheduleIds: {
            array_contains: [scheduleId.toLowerCase()],
          },
        },
        orderBy: { updatedAt: 'desc' },
        select: {
          repairTicketId: true,
          repairTicketNumber: true,
          repairStatus: true,
          outsideShopName: true,
        },
      });
      if (state) repairTicketId = state.repairTicketId;
    }
    if (!repairTicketId) {
      return { repairReferral: referral ?? null, repairTicket: null };
    }

    const ticket = await this.readTicketStatus(repairTicketId);
    return {
      repairReferral: referral ?? null,
      repairTicket: ticket,
    };
  }

  async readVehicleHistory(
    vehicleId: string,
    actor: ScheduleActor,
    cursor: string | undefined,
    rawLimit: string | undefined,
  ) {
    scheduleScope(actor);
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found.');

    if (cursor && cursor.length > 1000) {
      throw new BadRequestException('The VRMS history cursor is invalid.');
    }
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new BadRequestException(
        `History limit must be between 1 and ${MAX_PAGE_SIZE}.`,
      );
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const response = await this.getJson(
      this.historyTokens,
      `/vrms/integrations/vmms/vehicles/${encodeURIComponent(vehicleId)}/repair-history?${query.toString()}`,
    );
    if (!isRecord(response) || !Array.isArray(response.items)) {
      throw new BadGatewayException('VRMS returned an invalid repair history.');
    }

    const canViewCosts = actor.roles.some(
      (role) =>
        role.system === 'VMMS' &&
        ['ADMIN', 'OPERATIONS', 'CHIEF_MECHANIC'].includes(role.role),
    );
    const items = response.items.map((item) => {
      if (!isRecord(item)) {
        throw new BadGatewayException(
          'VRMS returned an invalid repair history item.',
        );
      }
      const result: Record<string, unknown> = {
        repairTicketId:
          typeof item.repairTicketId === 'string'
            ? item.repairTicketId
            : undefined,
        repairTicketNumber:
          typeof item.repairTicketNumber === 'string'
            ? item.repairTicketNumber
            : undefined,
        openedAt: typeof item.openedAt === 'string' ? item.openedAt : null,
        closedAt: typeof item.closedAt === 'string' ? item.closedAt : null,
        issues: textList(item.issues),
        partsUsed: textList(item.partsUsed),
        repairPersonnel: textList(item.repairPersonnel),
        provider: typeof item.provider === 'string' ? item.provider : null,
      };
      if (canViewCosts) {
        const totalRepairCost =
          typeof item.totalRepairCost === 'string'
            ? Number(item.totalRepairCost)
            : item.totalRepairCost;
        result.totalRepairCost =
          typeof totalRepairCost === 'number' &&
          Number.isFinite(totalRepairCost) &&
          totalRepairCost >= 0
            ? totalRepairCost
            : null;
      }
      return result;
    });
    return {
      items,
      nextCursor:
        typeof response.nextCursor === 'string' ? response.nextCursor : null,
    };
  }

  private async readTicketStatus(repairTicketId: string) {
    const response = await this.getJson(
      this.statusTokens,
      `/vrms/integrations/vmms/repairs/${encodeURIComponent(repairTicketId)}`,
    );
    if (!isRecord(response)) {
      throw new BadGatewayException('VRMS returned an invalid repair status.');
    }
    const status =
      typeof response.status === 'string' ? response.status : undefined;
    if (!status || !repairStatuses.has(status)) {
      throw new BadGatewayException('VRMS returned an invalid repair status.');
    }
    return {
      repairTicketId:
        typeof response.repairTicketId === 'string'
          ? response.repairTicketId
          : repairTicketId,
      repairTicketNumber:
        typeof response.repairTicketNumber === 'string'
          ? response.repairTicketNumber
          : null,
      status,
      outsideShopName:
        typeof response.outsideShopName === 'string'
          ? response.outsideShopName
          : null,
    };
  }

  private async getJson(
    tokens: ServiceTokenClient,
    path: string,
  ): Promise<unknown> {
    try {
      return await tokens.withToken(async (token) => {
        const response = await fetch(`${this.gatewayUrl}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 401) throw new UnauthorizedException();
        if (response.status === 404) {
          throw new NotFoundException('The repair record was not found in VRMS.');
        }
        if (response.status === 429 || response.status >= 500) {
          throw new ServiceUnavailableException(
            'VRMS repair data is temporarily unavailable.',
          );
        }
        if (response.status !== 200) {
          throw new BadGatewayException(
            'VRMS rejected the repair-data request.',
          );
        }
        try {
          return await response.json();
        } catch {
          throw new BadGatewayException(
            'VRMS returned an invalid repair-data response.',
          );
        }
      });
    } catch (error) {
      if (error instanceof HttpException) {
        if (error.getStatus() === 401) {
          throw new ServiceUnavailableException(
            'VMMS could not authenticate with VRMS.',
          );
        }
        throw error;
      }
      throw new ServiceUnavailableException(
        'VRMS repair data is temporarily unavailable.',
      );
    }
  }
}
