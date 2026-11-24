import { randomUUID } from 'node:crypto';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MaintenanceSchedule,
  Prisma,
  VmmsRepairReferralStatus,
} from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import type { Env } from '../../../../config/env';
import {
  ServiceTokenClient,
  VRMS_REFERRAL_TOKENS,
} from '../../../../auth/verify';
import { PrismaService } from '../../../../shared/prisma.service';

const REQUEST_TIMEOUT_MS = 5_000;
const CLAIM_LEASE_MS = 15_000;
const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_SECONDS = 60 * 60;

type ReferralPayload = {
  referralId: string;
  vmmsVehicleId: string;
  vehiclePlate: string;
  maintenanceScheduleId: string;
  workOrderNumber: string;
  odometerReading: number;
  findings: Array<{
    checklistItemId: string;
    label: string;
    note: string;
  }>;
  chiefMechanicRemarks: string;
};

class ReferralResponseError extends Error {
  constructor(readonly status: number) {
    super(`VRMS answered with status ${status}.`);
    this.name = 'ReferralResponseError';
  }
}

@Injectable()
export class VrmsRepairReferralsService {
  private readonly logger = new Logger(VrmsRepairReferralsService.name);
  private readonly gatewayUrl: string;
  private readonly maxAgeMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    @Inject(VRMS_REFERRAL_TOKENS)
    private readonly tokens: ServiceTokenClient,
  ) {
    this.gatewayUrl = config
      .get('SUITE_GATEWAY_INTERNAL_URL', { infer: true })
      .replace(/\/+$/, '');
    this.maxAgeMs =
      config.get('VMMS_REPAIR_REFERRAL_MAX_AGE_HOURS', { infer: true }) *
      60 *
      60 *
      1000;
  }

  async createFromWorkOrder(
    tx: Prisma.TransactionClient,
    schedule: MaintenanceSchedule,
    progress: Record<string, unknown>,
  ): Promise<{ id: string; created: boolean }> {
    const previous = await tx.vmmsRepairReferral.findFirst({
      where: {
        maintenanceScheduleId: schedule.id,
        status: {
          in: [
            VmmsRepairReferralStatus.QUEUED,
            VmmsRepairReferralStatus.SENT,
            VmmsRepairReferralStatus.FAILED,
            VmmsRepairReferralStatus.ACCEPTED,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (previous) return { id: previous.id, created: false };

    const vehicle = await tx.vehicle.findFirst({
      where: {
        plateNumber: schedule.vehicleId,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true, plateNumber: true, odometer: true },
    });
    if (!vehicle) {
      throw new NotFoundException('The assigned truck could not be found.');
    }

    const inspectionItems = Array.isArray(progress.inspectionItems)
      ? progress.inspectionItems
      : [];
    const findings = inspectionItems
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          item.status === 'fail',
      )
      .map((item) => ({
        checklistItemId:
          typeof item.id === 'string' ? item.id : '',
        label: typeof item.label === 'string' ? item.label : '',
        note: typeof item.note === 'string' ? item.note : '',
      }));
    if (!findings.length) {
      throw new HttpException(
        'Mark at least one inspection item as failed before referring the work order.',
        400,
      );
    }

    const serviceOdometer = progress.serviceOdometerReading;
    const odometerReading =
      typeof serviceOdometer === 'number' &&
      Number.isSafeInteger(serviceOdometer) &&
      serviceOdometer >= 0
        ? serviceOdometer
        : vehicle.odometer;
    const id = randomUUID();
    const payload: ReferralPayload = {
      referralId: id,
      vmmsVehicleId: vehicle.id,
      vehiclePlate: vehicle.plateNumber,
      maintenanceScheduleId: schedule.id,
      workOrderNumber: schedule.workOrderNumber,
      odometerReading,
      findings,
      chiefMechanicRemarks:
        typeof progress.inspectorRemarks === 'string'
          ? progress.inspectorRemarks.trim()
          : '',
    };

    await tx.vmmsRepairReferral.create({
      data: {
        id,
        vehicleId: vehicle.id,
        maintenanceScheduleId: schedule.id,
        workOrderNumber: schedule.workOrderNumber,
        status: VmmsRepairReferralStatus.QUEUED,
        requestPayload: payload as unknown as Prisma.InputJsonValue,
      },
    });
    return { id, created: true };
  }

  async retryFailed(id: string) {
    const referral = await this.prisma.vmmsRepairReferral.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!referral) throw new NotFoundException('Repair referral not found.');
    if (referral.status !== VmmsRepairReferralStatus.FAILED) {
      throw new HttpException(
        'Only failed repair referrals can be retried.',
        409,
      );
    }
    await this.prisma.vmmsRepairReferral.updateMany({
      where: { id, status: VmmsRepairReferralStatus.FAILED },
      data: {
        status: VmmsRepairReferralStatus.QUEUED,
        attemptWindowStartedAt: new Date(),
        nextAttemptAt: new Date(),
        attempts: 0,
        failedAt: null,
        lastErrorCode: null,
        manualRetryCount: { increment: 1 },
      },
    });
    await this.deliverOne(id);
    return this.getReferral(id);
  }

  async getLatestForSchedule(maintenanceScheduleId: string) {
    return this.prisma.vmmsRepairReferral.findFirst({
      where: { maintenanceScheduleId },
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
        createdAt: true,
      },
    });
  }

  @Cron('*/1 * * * *', { waitForCompletion: true })
  async deliverPending(): Promise<void> {
    try {
      const now = new Date();
      const due = await this.prisma.vmmsRepairReferral.findMany({
        where: {
          status: VmmsRepairReferralStatus.QUEUED,
          nextAttemptAt: { lte: now },
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        take: 100,
        select: { id: true },
      });
      for (const referral of due) {
        await this.deliverOne(referral.id);
      }
    } catch (error) {
      this.logger.error(
        'VRMS repair-referral delivery queue failed.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async deliverOne(id: string): Promise<void> {
    const referral = await this.prisma.vmmsRepairReferral.findUnique({
      where: { id },
      select: {
        id: true,
        requestPayload: true,
        status: true,
        attempts: true,
        attemptWindowStartedAt: true,
        nextAttemptAt: true,
      },
    });
    if (
      !referral ||
      referral.status !== VmmsRepairReferralStatus.QUEUED ||
      !referral.nextAttemptAt ||
      referral.nextAttemptAt > new Date()
    ) {
      return;
    }
    const now = new Date();
    if (!(await this.claim(id, now))) return;
    if (
      now.getTime() - referral.attemptWindowStartedAt.getTime() >=
      this.maxAgeMs
    ) {
      await this.markFailed(id, 'retry_window_expired');
      return;
    }

    try {
      await this.send(referral.id, referral.requestPayload);
      await this.prisma.vmmsRepairReferral.updateMany({
        where: { id, status: VmmsRepairReferralStatus.QUEUED },
        data: {
          status: VmmsRepairReferralStatus.SENT,
          deliveredAt: new Date(),
          nextAttemptAt: null,
          lastErrorCode: null,
        },
      });
    } catch (error) {
      const errorCode = this.errorCode(error);
      if (!this.isRetryable(error)) {
        await this.markFailed(id, errorCode);
      } else {
        const age = Date.now() - referral.attemptWindowStartedAt.getTime();
        if (age >= this.maxAgeMs) {
          await this.markFailed(id, 'retry_window_expired');
          return;
        }
        const attempt = referral.attempts + 1;
        const delay = Math.min(
          RETRY_BASE_SECONDS * 2 ** Math.min(attempt - 1, 10),
          RETRY_MAX_SECONDS,
        );
        await this.prisma.vmmsRepairReferral.updateMany({
          where: { id, status: VmmsRepairReferralStatus.QUEUED },
          data: {
            nextAttemptAt: new Date(Date.now() + delay * 1000),
            lastErrorCode: errorCode,
          },
        });
        this.logger.warn(
          `VRMS referral ${id} delivery failed (${errorCode}); retrying in ${delay}s.`,
        );
      }
    }
  }

  private async claim(id: string, now: Date): Promise<boolean> {
    const result = await this.prisma.vmmsRepairReferral.updateMany({
      where: {
        id,
        status: VmmsRepairReferralStatus.QUEUED,
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

  private async send(
    referralId: string,
    payload: Prisma.JsonValue,
  ): Promise<void> {
    await this.tokens.withToken(async (token) => {
      const response = await fetch(
        `${this.gatewayUrl}/vrms/integrations/vmms/repair-referrals`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': referralId,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (response.status === 401) {
        throw new HttpException('VRMS service rejected the token.', 401);
      }
      if (response.status !== 202) {
        throw new ReferralResponseError(response.status);
      }
    });
  }

  private async markFailed(id: string, errorCode: string): Promise<void> {
    await this.prisma.vmmsRepairReferral.updateMany({
      where: {
        id,
        status: VmmsRepairReferralStatus.QUEUED,
      },
      data: {
        status: VmmsRepairReferralStatus.FAILED,
        failedAt: new Date(),
        nextAttemptAt: null,
        lastErrorCode: errorCode,
      },
    });
  }

  private async getReferral(id: string) {
    const referral = await this.getLatestReferralById(id);
    if (!referral) throw new NotFoundException('Repair referral not found.');
    return referral;
  }

  private getLatestReferralById(id: string) {
    return this.prisma.vmmsRepairReferral.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        repairTicketId: true,
        repairTicketNumber: true,
        repairStatus: true,
        outsideShopName: true,
        outcomeReason: true,
        lastErrorCode: true,
        createdAt: true,
      },
    });
  }

  private errorCode(error: unknown): string {
    if (error instanceof ReferralResponseError)
      return `http_${error.status}`;
    if (error instanceof HttpException) return `http_${error.getStatus()}`;
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
    return 'network_error';
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof ReferralResponseError) {
      return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    if (error instanceof HttpException) {
      const status = error.getStatus();
      return status === 408 || status === 429 || status >= 500;
    }
    return true;
  }
}
