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
import { Prisma } from '@prisma/client';
import type { Env } from '../../../../config/env';
import {
  BMS_FLEET_CHANGE_TOKENS,
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
export class BmsFleetChangesService {
  private readonly logger = new Logger(BmsFleetChangesService.name);
  private readonly gatewayUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    @Inject(BMS_FLEET_CHANGE_TOKENS)
    private readonly tokens: ServiceTokenClient,
  ) {
    this.gatewayUrl = config
      .get('SUITE_GATEWAY_INTERNAL_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  async recordChange(
    tx: Prisma.TransactionClient,
    event: {
      entityType: 'VEHICLE' | 'GARAGE';
      entityId: string;
      changeType: string;
    },
  ): Promise<void> {
    await tx.bmsFleetChangeEvent.create({
      data: {
        eventId: randomUUID(),
        entityType: event.entityType,
        entityId: event.entityId,
        changeType: event.changeType,
        occurredAt: new Date(),
      },
    });
  }

  @Cron('*/1 * * * *', { waitForCompletion: true })
  async deliverPending(): Promise<void> {
    try {
      const now = new Date();
      const events = await this.prisma.bmsFleetChangeEvent.findMany({
        where: { sentAt: null, nextAttemptAt: { lte: now } },
        orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }],
        take: 100,
      });

      for (const event of events) {
        const claimed = await this.claim(event.eventId, now);
        if (!claimed) continue;

        try {
          await this.send(event);
          await this.prisma.bmsFleetChangeEvent.updateMany({
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
          await this.prisma.bmsFleetChangeEvent.updateMany({
            where: { eventId: event.eventId, sentAt: null },
            data: {
              nextAttemptAt: new Date(Date.now() + delay * 1000),
              lastErrorCode: errorCode,
            },
          });
          this.logger.warn(
            `BMS fleet-change event ${event.eventId} delivery failed (${errorCode}); retrying in ${delay}s.`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'BMS fleet-change outbox processing failed.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async claim(eventId: string, now: Date): Promise<boolean> {
    const result = await this.prisma.bmsFleetChangeEvent.updateMany({
      where: {
        eventId,
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
  }

  private async send(event: {
    eventId: string;
    entityType: string;
    entityId: string;
    changeType: string;
    occurredAt: Date;
  }): Promise<void> {
    await this.tokens.withToken(async (token) => {
      const response = await fetch(
        `${this.gatewayUrl}/bms/integrations/vmms/fleet-changes`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventId: event.eventId,
            entityType: event.entityType,
            entityId: event.entityId,
            changeType: event.changeType,
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
