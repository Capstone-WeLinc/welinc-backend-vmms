import { randomUUID } from 'node:crypto';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma, Vehicle, VehicleStatus } from '@prisma/client';
import type { Env } from '../../../../config/env';
import {
  BMS_AVAILABILITY_TOKENS,
  ServiceTokenClient,
} from '../../../../auth/verify';
import { PrismaService } from '../../../../shared/prisma.service';

const REQUEST_TIMEOUT_MS = 5_000;
const CLAIM_LEASE_MS = 15_000;
const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_SECONDS = 60 * 60;

class IntegrationResponseError extends Error {
  constructor(readonly status: number) {
    super(`BMS answered with status ${status}.`);
    this.name = 'IntegrationResponseError';
  }
}

@Injectable()
export class BmsAvailabilityService {
  private readonly logger = new Logger(BmsAvailabilityService.name);
  private readonly gatewayUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    @Inject(BMS_AVAILABILITY_TOKENS)
    private readonly tokens: ServiceTokenClient,
  ) {
    this.gatewayUrl = config
      .get('SUITE_GATEWAY_INTERNAL_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  async recordStatusChange(
    tx: Prisma.TransactionClient,
    vehicle: Pick<
      Vehicle,
      'id' | 'plateNumber' | 'status' | 'availabilityVersion'
    >,
  ): Promise<void> {
    if (vehicle.availabilityVersion < 1) {
      throw new Error('Vehicle availability version must be positive.');
    }
    await tx.bmsVehicleAvailabilityEvent.create({
      data: {
        eventId: randomUUID(),
        vehicleId: vehicle.id,
        eventVersion: vehicle.availabilityVersion,
        status: vehicle.status,
        occurredAt: new Date(),
      },
    });
  }

  @Cron('*/1 * * * *', { waitForCompletion: true })
  async deliverPending(): Promise<void> {
    try {
      const now = new Date();
      const events = await this.prisma.bmsVehicleAvailabilityEvent.findMany({
        where: { sentAt: null, nextAttemptAt: { lte: now } },
        orderBy: [{ vehicleId: 'asc' }, { eventVersion: 'asc' }],
        take: 100,
        include: { vehicle: { select: { plateNumber: true } } },
      });
      const blockedVehicles = new Set<string>();

      for (const event of events) {
        if (blockedVehicles.has(event.vehicleId)) continue;
        const claimed = await this.claim(event, now);
        if (!claimed) {
          blockedVehicles.add(event.vehicleId);
          continue;
        }

        try {
          await this.send(event, event.vehicle.plateNumber);
          await this.prisma.bmsVehicleAvailabilityEvent.updateMany({
            where: { eventId: event.eventId, sentAt: null },
            data: { sentAt: new Date(), lastErrorCode: null },
          });
        } catch (error) {
          blockedVehicles.add(event.vehicleId);
          const errorCode = this.errorCode(error);
          const attempt = event.attempts + 1;
          const delay = Math.min(
            RETRY_BASE_SECONDS * 2 ** Math.min(attempt - 1, 10),
            RETRY_MAX_SECONDS,
          );
          await this.prisma.bmsVehicleAvailabilityEvent.updateMany({
            where: { eventId: event.eventId, sentAt: null },
            data: {
              nextAttemptAt: new Date(Date.now() + delay * 1000),
              lastErrorCode: errorCode,
            },
          });
          this.logger.warn(
            `BMS availability event ${event.eventId} delivery failed (${errorCode}); retrying in ${delay}s.`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'BMS availability outbox processing failed.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async claim(
    event: { eventId: string; vehicleId: string; eventVersion: number },
    now: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`bms-availability:${event.vehicleId}`}, 0)
        )
      `;
      const earlierPending = await tx.bmsVehicleAvailabilityEvent.findFirst({
        where: {
          vehicleId: event.vehicleId,
          eventVersion: { lt: event.eventVersion },
          sentAt: null,
        },
        select: { eventId: true },
      });
      if (earlierPending) return false;

      const result = await tx.bmsVehicleAvailabilityEvent.updateMany({
        where: {
          eventId: event.eventId,
          sentAt: null,
          nextAttemptAt: { lte: now },
        },
        data: {
          attempts: { increment: 1 },
          lastAttemptAt: now,
          nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        },
      });
      return result.count === 1;
    });
  }

  private async send(
    event: {
      eventId: string;
      vehicleId: string;
      eventVersion: number;
      status: VehicleStatus;
      occurredAt: Date;
    },
    vehiclePlate: string,
  ): Promise<void> {
    await this.tokens.withToken(async (token) => {
      const response = await fetch(
        `${this.gatewayUrl}/bms/integrations/vmms/vehicle-availability`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventId: event.eventId,
            eventVersion: event.eventVersion,
            vmmsVehicleId: event.vehicleId,
            vehiclePlate,
            status: event.status,
            occurredAt: event.occurredAt.toISOString(),
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );

      if (response.status === 401) throw new UnauthorizedException();
      if (response.status !== 200 && response.status !== 202)
        throw new IntegrationResponseError(response.status);
    });
  }

  private errorCode(error: unknown): string {
    if (error instanceof IntegrationResponseError)
      return `http_${error.status}`;
    if (error instanceof HttpException) return `http_${error.getStatus()}`;
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
    return 'network_error';
  }
}
