import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  Prisma,
  VrmsRepairIntegrationStatus,
  VrmsRetirementDecision,
  VrmsRetirementRequestStatus,
} from '@prisma/client';
import type { Env } from '../../../../config/env';
import {
  ServiceTokenClient,
  VRMS_RETIREMENT_DECISION_TOKENS,
} from '../../../../auth/verify';
import { PrismaService } from '../../../../shared/prisma.service';
import { BmsFleetChangesService } from '../bms/bms-fleet-changes.service';
import { VrmsRepairEventsService } from './vrms-repair-events.service';
import { VrmsRetirementDecisionDto } from './vrms-retirement-decision.dto';
import { VrmsRetirementRequestDto } from './vrms-retirement-request.dto';

const REQUEST_TIMEOUT_MS = 5_000;
const CLAIM_LEASE_MS = 15_000;
const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_SECONDS = 60 * 60;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class RetirementDecisionResponseError extends Error {
  constructor(readonly status: number) {
    super(`VRMS answered with status ${status}.`);
    this.name = 'RetirementDecisionResponseError';
  }
}

type RetirementActor = { sub: string; email: string };

@Injectable()
export class VrmsRetirementRequestsService {
  private readonly logger = new Logger(VrmsRetirementRequestsService.name);
  private readonly gatewayUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repairEvents: VrmsRepairEventsService,
    private readonly fleetChanges: BmsFleetChangesService,
    config: ConfigService<Env, true>,
    @Inject(VRMS_RETIREMENT_DECISION_TOKENS)
    private readonly tokens: ServiceTokenClient,
  ) {
    this.gatewayUrl = config
      .get('SUITE_GATEWAY_INTERNAL_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  async receive(event: VrmsRetirementRequestDto) {
    const eventId = event.eventId.toLowerCase();
    const requestId = event.requestId.toLowerCase();
    const vehicleId = event.vmmsVehicleId.toLowerCase();
    const repairTicketId = event.repairTicketId.toLowerCase();
    const repairTicketNumber = event.repairTicketNumber.trim();
    const reason = event.reason.trim();
    const occurredAt = new Date(event.occurredAt);
    if (!/(Z|\+00:00)$/i.test(event.occurredAt)) {
      throw new BadRequestException('occurredAt must be a UTC timestamp.');
    }
    if (!repairTicketNumber) {
      throw new BadRequestException('A repair ticket number is required.');
    }
    if (reason.length < 5 || reason.length > 500) {
      throw new BadRequestException(
        'A retirement reason of 5 to 500 characters is required.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`retirement-event:${eventId}`}, 0))
      `;
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`retirement-request:${requestId}`}, 0))
      `;
      const previous = await tx.vrmsRetirementRequest.findUnique({
        where: { eventId },
      });
      if (previous) {
        if (
          previous.requestId === requestId &&
          previous.vehicleId === vehicleId &&
          previous.repairTicketId === repairTicketId &&
          previous.repairTicketNumber === repairTicketNumber &&
          previous.reason === reason &&
          previous.occurredAt.getTime() === occurredAt.getTime()
        ) {
          return { accepted: true, duplicate: true };
        }
        throw new ConflictException({
          code: 'EVENT_ID_REUSED',
          message: 'This event ID was already used with a different payload.',
        });
      }
      const previousRequest = await tx.vrmsRetirementRequest.findUnique({
        where: { requestId },
        select: { requestId: true },
      });
      if (previousRequest) {
        throw new ConflictException({
          code: 'REQUEST_ID_REUSED',
          message: 'This retirement request ID is already in use.',
        });
      }

      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`vehicle:${vehicleId}`}, 0))
      `;
      const vehicle = await tx.vehicle.findFirst({
        where: { id: vehicleId, isActive: true, deletedAt: null },
        select: { id: true },
      });
      if (!vehicle) {
        throw new NotFoundException({
          code: 'VEHICLE_NOT_FOUND',
          message: 'The VMMS vehicle is not active.',
        });
      }
      const repair = await tx.vrmsRepairIntegrationState.findUnique({
        where: { repairTicketId },
        select: {
          vehicleId: true,
          repairTicketNumber: true,
          status: true,
        },
      });
      if (
        !repair ||
        repair.vehicleId !== vehicleId ||
        repair.status !== VrmsRepairIntegrationStatus.OPEN ||
        repair.repairTicketNumber !== repairTicketNumber
      ) {
        throw new ConflictException({
          code: 'INVALID_RETIREMENT_REQUEST',
          message: 'The request does not match an open repair on this vehicle.',
        });
      }
      const priorTicketRequest = await tx.vrmsRetirementRequest.findUnique({
        where: { repairTicketId },
        select: { requestId: true },
      });
      if (priorTicketRequest) {
        throw new ConflictException({
          code: 'RETIREMENT_ALREADY_REQUESTED',
          message: 'This repair ticket already has a retirement request.',
        });
      }

      await tx.vrmsRetirementRequest.create({
        data: {
          eventId,
          requestId,
          vehicleId,
          repairTicketId,
          repairTicketNumber,
          reason,
          occurredAt,
        },
      });
      return { accepted: true, duplicate: false };
    });
  }

  async pending(
    cursor: string | undefined,
    requestedLimit: string | undefined,
  ) {
    if (cursor !== undefined && !UUID_PATTERN.test(cursor)) {
      throw new BadRequestException(
        'The retirement request cursor is invalid.',
      );
    }
    if (requestedLimit !== undefined && !/^\d+$/.test(requestedLimit)) {
      throw new BadRequestException('limit must be an integer from 1 to 100.');
    }
    const limit = requestedLimit === undefined ? 50 : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer from 1 to 100.');
    }

    let where: Prisma.VrmsRetirementRequestWhereInput = {
      status: VrmsRetirementRequestStatus.PENDING,
    };
    if (cursor !== undefined) {
      const normalizedCursor = cursor.toLowerCase();
      const anchor = await this.prisma.vrmsRetirementRequest.findUnique({
        where: { requestId: normalizedCursor },
        select: { requestId: true, occurredAt: true },
      });
      if (!anchor) {
        throw new BadRequestException(
          'The retirement request cursor is invalid.',
        );
      }
      where = {
        status: VrmsRetirementRequestStatus.PENDING,
        OR: [
          { occurredAt: { gt: anchor.occurredAt } },
          {
            occurredAt: anchor.occurredAt,
            requestId: { gt: anchor.requestId },
          },
        ],
      };
    }
    const rows = await this.prisma.vrmsRetirementRequest.findMany({
      where,
      include: { vehicle: { select: { plateNumber: true } } },
      orderBy: [{ occurredAt: 'asc' }, { requestId: 'asc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
      requestId: row.requestId,
      vmmsVehicleId: row.vehicleId,
      vehiclePlate: row.vehicle.plateNumber,
      repairTicketId: row.repairTicketId,
      repairTicketNumber: row.repairTicketNumber,
      reason: row.reason,
      occurredAt: row.occurredAt.toISOString(),
    }));
    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.requestId ?? null) : null,
    };
  }

  async decide(
    requestId: string,
    input: VrmsRetirementDecisionDto,
    actor: RetirementActor,
  ) {
    const normalizedRequestId = requestId.toLowerCase();
    const reason = input.reason?.trim() || null;
    if (input.decision === VrmsRetirementDecision.DECLINED && !reason) {
      throw new BadRequestException(
        'A reason is required when declining a retirement request.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`retirement-request:${normalizedRequestId}`}, 0))
      `;
      const request = await tx.vrmsRetirementRequest.findUnique({
        where: { requestId: normalizedRequestId },
      });
      if (!request) {
        throw new NotFoundException('Retirement request not found.');
      }
      if (request.status !== VrmsRetirementRequestStatus.PENDING) {
        throw new ConflictException(
          'This retirement request has already been decided.',
        );
      }

      const decisionAt = new Date();
      if (input.decision === VrmsRetirementDecision.APPROVED) {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`vehicle:${request.vehicleId}`}, 0))
        `;
        const vehicle = await tx.vehicle.findFirst({
          where: {
            id: request.vehicleId,
            isActive: true,
            deletedAt: null,
          },
          select: { id: true, isActive: true },
        });
        if (!vehicle) {
          throw new ConflictException(
            'The vehicle is no longer active and cannot be retired again.',
          );
        }
        const openRepairs = await tx.vrmsRepairIntegrationState.findMany({
          where: {
            vehicleId: request.vehicleId,
            status: VrmsRepairIntegrationStatus.OPEN,
          },
          select: { repairTicketId: true },
        });
        if (
          openRepairs.length !== 1 ||
          openRepairs[0]?.repairTicketId !== request.repairTicketId
        ) {
          throw new ConflictException(
            'Resolve other open VRMS repairs before approving this retirement.',
          );
        }

        await this.repairEvents.closeForRetirement(
          tx,
          request.repairTicketId,
          request.vehicleId,
        );
        const deactivated = await tx.vehicle.updateMany({
          where: {
            id: request.vehicleId,
            isActive: true,
            deletedAt: null,
          },
          data: { isActive: false },
        });
        if (deactivated.count !== 1) {
          throw new ConflictException(
            'The vehicle changed while approving retirement.',
          );
        }
        await tx.vehicleAuditLog.create({
          data: {
            vehicleId: request.vehicleId,
            userId: actor.sub,
            email: actor.email,
            action: 'VEHICLE_UPDATED',
            fieldName: 'isActive',
            previousValue: 'true',
            newValue: 'false',
          },
        });
        await this.fleetChanges.recordChange(tx, {
          entityType: 'VEHICLE',
          entityId: request.vehicleId,
          changeType: 'VEHICLE_DEACTIVATED',
        });
      }

      const status =
        input.decision === VrmsRetirementDecision.APPROVED
          ? VrmsRetirementRequestStatus.APPROVED
          : VrmsRetirementRequestStatus.DECLINED;
      await tx.vrmsRetirementRequest.update({
        where: { requestId: normalizedRequestId },
        data: {
          status,
          decisionReason: reason,
          decidedById: actor.sub,
          decidedAt: decisionAt,
        },
      });
      const decisionEventId = randomUUID();
      await tx.vrmsRetirementDecisionOutbox.create({
        data: {
          eventId: decisionEventId,
          requestId: normalizedRequestId,
          decision: input.decision,
          reason,
          occurredAt: decisionAt,
        },
      });
      return {
        requestId: normalizedRequestId,
        decision: input.decision,
        reason,
        deliveryEventId: decisionEventId,
        deliveryStatus: 'QUEUED',
      };
    });
  }

  @Cron('*/1 * * * *', { waitForCompletion: true })
  async deliverPending(): Promise<void> {
    try {
      const now = new Date();
      const due = await this.prisma.vrmsRetirementDecisionOutbox.findMany({
        where: { sentAt: null, nextAttemptAt: { lte: now } },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        take: 100,
      });
      for (const event of due) {
        if (!(await this.claim(event.eventId, now))) continue;
        try {
          await this.send(event);
          await this.prisma.vrmsRetirementDecisionOutbox.updateMany({
            where: { eventId: event.eventId, sentAt: null },
            data: { sentAt: new Date(), lastErrorCode: null },
          });
        } catch (error) {
          const errorCode = this.errorCode(error);
          const attempt = event.attempts + 1;
          const delay = Math.min(
            RETRY_BASE_SECONDS * 2 ** Math.min(attempt - 1, 10),
            RETRY_MAX_SECONDS,
          );
          await this.prisma.vrmsRetirementDecisionOutbox.updateMany({
            where: { eventId: event.eventId, sentAt: null },
            data: {
              nextAttemptAt: new Date(Date.now() + delay * 1000),
              lastErrorCode: errorCode,
            },
          });
          this.logger.warn(
            `VRMS retirement decision ${event.eventId} delivery failed (${errorCode}); retrying in ${delay}s.`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'VRMS retirement-decision delivery queue failed.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async claim(eventId: string, now: Date): Promise<boolean> {
    const result = await this.prisma.vrmsRetirementDecisionOutbox.updateMany({
      where: { eventId, sentAt: null, nextAttemptAt: { lte: now } },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      },
    });
    return result.count === 1;
  }

  private async send(event: {
    eventId: string;
    requestId: string;
    decision: VrmsRetirementDecision;
    reason: string | null;
    occurredAt: Date;
  }): Promise<void> {
    const body = {
      eventId: event.eventId,
      requestId: event.requestId,
      decision: event.decision,
      ...(event.reason ? { reason: event.reason } : {}),
      occurredAt: event.occurredAt.toISOString(),
    };
    await this.tokens.withToken(async (token) => {
      const response = await fetch(
        `${this.gatewayUrl}/vrms/integrations/vmms/retirement-decisions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (response.status !== 200 && response.status !== 202) {
        throw new RetirementDecisionResponseError(response.status);
      }
    });
  }

  private errorCode(error: unknown): string {
    if (error instanceof RetirementDecisionResponseError) {
      return `http_${error.status}`;
    }
    if (error instanceof HttpException) {
      return `http_${error.getStatus()}`;
    }
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
    return 'network_error';
  }
}
