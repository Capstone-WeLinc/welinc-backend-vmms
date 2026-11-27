import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma.service';
import { VrmsRepeatRepairAlertDto } from './vrms-repeat-repair-alert.dto';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ticketNumbers(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : [];
}

@Injectable()
export class VrmsRepeatRepairAlertsService {
  constructor(private readonly prisma: PrismaService) {}

  async receive(event: VrmsRepeatRepairAlertDto) {
    const eventId = event.eventId.toLowerCase();
    const vehicleId = event.vmmsVehicleId.toLowerCase();
    const category = event.category.trim();
    const repairTicketNumbers = event.repairTicketNumbers.map((value) =>
      value.trim(),
    );
    const occurredAt = new Date(event.occurredAt);
    if (!category || repairTicketNumbers.some((value) => !value)) {
      throw new BadRequestException(
        'A category and non-empty repair ticket numbers are required.',
      );
    }
    if (!/(Z|\+00:00)$/i.test(event.occurredAt)) {
      throw new BadRequestException('occurredAt must be a UTC timestamp.');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`repeat-repair:${eventId}`}, 0))
      `;
      const previous = await tx.vrmsRepeatRepairAlert.findUnique({
        where: { eventId },
      });
      if (previous) {
        if (
          previous.vehicleId === vehicleId &&
          previous.category === category &&
          JSON.stringify(ticketNumbers(previous.repairTicketNumbers)) ===
            JSON.stringify(repairTicketNumbers) &&
          previous.windowDays === event.windowDays &&
          previous.count === event.count &&
          previous.occurredAt.getTime() === occurredAt.getTime()
        ) {
          return { accepted: true, duplicate: true };
        }
        throw new ConflictException({
          code: 'EVENT_ID_REUSED',
          message: 'This event ID was already used with a different payload.',
        });
      }

      const vehicle = await tx.vehicle.findFirst({
        where: { id: vehicleId, deletedAt: null },
        select: { id: true },
      });
      if (!vehicle) {
        throw new NotFoundException({
          code: 'VEHICLE_NOT_FOUND',
          message: 'The VMMS vehicle was not found.',
        });
      }

      await tx.vrmsRepeatRepairAlert.create({
        data: {
          eventId,
          vehicleId,
          category,
          repairTicketNumbers,
          windowDays: event.windowDays,
          count: event.count,
          occurredAt,
        },
      });
      return { accepted: true, duplicate: false };
    });
  }

  async list(cursor: string | undefined, requestedLimit: string | undefined) {
    if (cursor !== undefined && !UUID_PATTERN.test(cursor)) {
      throw new BadRequestException('The repeat-repair cursor is invalid.');
    }
    if (requestedLimit !== undefined && !/^\d+$/.test(requestedLimit)) {
      throw new BadRequestException('limit must be an integer from 1 to 100.');
    }
    const limit = requestedLimit === undefined ? 50 : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer from 1 to 100.');
    }

    let where: Prisma.VrmsRepeatRepairAlertWhereInput = {};
    if (cursor !== undefined) {
      const normalizedCursor = cursor.toLowerCase();
      const anchor = await this.prisma.vrmsRepeatRepairAlert.findUnique({
        where: { eventId: normalizedCursor },
        select: { eventId: true, occurredAt: true },
      });
      if (!anchor) {
        throw new BadRequestException('The repeat-repair cursor is invalid.');
      }
      where = {
        OR: [
          { occurredAt: { lt: anchor.occurredAt } },
          {
            occurredAt: anchor.occurredAt,
            eventId: { lt: anchor.eventId },
          },
        ],
      };
    }
    const rows = await this.prisma.vrmsRepeatRepairAlert.findMany({
      where,
      include: { vehicle: { select: { plateNumber: true } } },
      orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
      eventId: row.eventId,
      vmmsVehicleId: row.vehicleId,
      vehiclePlate: row.vehicle.plateNumber,
      category: row.category,
      repairTicketNumbers: ticketNumbers(row.repairTicketNumbers),
      windowDays: row.windowDays,
      count: row.count,
      occurredAt: row.occurredAt.toISOString(),
    }));
    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.eventId ?? null) : null,
    };
  }
}
