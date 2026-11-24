import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MaintenanceApprovalStatus,
  MaintenanceStatus,
  Prisma,
  VehicleStatus,
  VmmsRepairReferralStatus,
  VrmsRepairEventType,
  VrmsRepairIntegrationStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma.service';
import { MaintenanceSchedulesService } from '../../maintenance-schedules/maintenance-schedules.service';
import { BmsAvailabilityService } from '../bms/bms-availability.service';
import { VrmsRepairEventDto } from './vrms-repair-event.dto';
import { VrmsRepairReferralEventDto } from './vrms-repair-referral-event.dto';

function sortedIds(ids: string[]): string[] {
  const normalized = ids.map((id) => id.toLowerCase()).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new BadRequestException('Schedule IDs must be unique.');
  }
  return normalized;
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return [];
    ids.push(item);
  }
  return ids;
}

function isRecord(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

@Injectable()
export class VrmsRepairEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maintenanceSchedules: MaintenanceSchedulesService,
    private readonly availability: BmsAvailabilityService,
  ) {}

  async apply(event: VrmsRepairEventDto) {
    const eventId = event.eventId.toLowerCase();
    const repairTicketId = event.repairTicketId.toLowerCase();
    const vehicleId = event.vmmsVehicleId.toLowerCase();
    const scheduleIds = sortedIds(event.maintenanceScheduleIds);
    const acceptedReferralIds = sortedIds(event.acceptedReferralIds ?? []);
    const occurredAt = new Date(event.occurredAt);
    const repairTicketNumber = event.repairTicketNumber?.trim();
    const repairStatus = event.repairStatus;

    if (!/(Z|\+00:00)$/i.test(event.occurredAt)) {
      throw new BadRequestException('occurredAt must be a UTC timestamp.');
    }
    if (!repairTicketNumber || !repairStatus) {
      throw new BadRequestException(
        'repairTicketNumber and repairStatus are required.',
      );
    }
    if (
      (event.eventType === VrmsRepairEventType.OPENED &&
        repairStatus !== 'OPEN') ||
      (event.eventType === VrmsRepairEventType.COMPLETED &&
        repairStatus !== 'CLOSED') ||
      (event.eventType === VrmsRepairEventType.CANCELLED &&
        repairStatus !== 'CANCELLED')
    ) {
      throw this.eventConflict(
        'The repair status does not match the lifecycle event type.',
      );
    }
    if (
      event.eventType !== VrmsRepairEventType.COMPLETED &&
      event.serviceOdometerReading !== undefined
    ) {
      throw new BadRequestException(
        'serviceOdometerReading is only valid for a completed repair.',
      );
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`event:${eventId}`}, 0))
        `;
          await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`ticket:${repairTicketId}`}, 0))
        `;
          await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`vehicle:${vehicleId}`}, 0))
        `;

          const receipt = await tx.vrmsRepairEventReceipt.findUnique({
            where: { eventId },
          });
          if (receipt) {
            if (
              receipt.repairTicketId === repairTicketId &&
              receipt.eventVersion === event.eventVersion &&
              receipt.eventType === event.eventType &&
              receipt.vmmsVehicleId === vehicleId &&
              sameIds(
                jsonStringArray(receipt.maintenanceScheduleIds),
                scheduleIds,
              ) &&
              sameIds(
                jsonStringArray(receipt.acceptedReferralIds),
                acceptedReferralIds,
              ) &&
              receipt.occurredAt.getTime() === occurredAt.getTime() &&
              receipt.repairTicketNumber === repairTicketNumber &&
              receipt.repairStatus === repairStatus &&
              (receipt.outsideShopName?.toLowerCase() ?? null) ===
                (event.outsideShopName?.trim().toLowerCase() ?? null) &&
              receipt.serviceOdometerReading ===
                (event.serviceOdometerReading ?? null)
            ) {
              return { accepted: true, duplicate: true };
            }
            throw new ConflictException({
              code: 'EVENT_ID_REUSED',
              message:
                'This event ID was already used with a different payload.',
            });
          }

          const vehicle = await tx.vehicle.findFirst({
            where: { id: vehicleId, isActive: true, deletedAt: null },
            select: { id: true, plateNumber: true },
          });
          if (!vehicle) {
            throw new NotFoundException({
              code: 'VEHICLE_NOT_FOUND',
              message: 'The VMMS vehicle was not found.',
            });
          }
          const outsideShopName = await this.resolveOutsideShopName(
            tx,
            repairStatus,
            event.outsideShopName,
          );

          const state = await tx.vrmsRepairIntegrationState.findUnique({
            where: { repairTicketId },
          });
          if (
            state?.repairTicketNumber &&
            state.repairTicketNumber !== repairTicketNumber
          ) {
            throw this.eventConflict(
              'A repair ticket number cannot change after the ticket is linked.',
            );
          }
          if (state && state.vehicleId !== vehicleId) {
            throw new ConflictException({
              code: 'REPAIR_VEHICLE_CHANGED',
              message: 'A repair ticket cannot change its VMMS vehicle.',
            });
          }

          if (!state) {
            if (
              event.eventType !== VrmsRepairEventType.OPENED ||
              event.eventVersion !== 1
            ) {
              throw this.eventConflict(
                'The first event for a repair ticket must be OPENED version 1.',
              );
            }
            const otherOpen = await tx.vrmsRepairIntegrationState.findFirst({
              where: {
                vehicleId,
                status: VrmsRepairIntegrationStatus.OPEN,
              },
              select: { repairTicketId: true },
            });
            if (otherOpen) {
              throw this.eventConflict(
                'The VMMS vehicle already has an open VRMS repair.',
              );
            }
          } else {
            if (state.status !== VrmsRepairIntegrationStatus.OPEN) {
              throw this.eventConflict('The VRMS repair is already closed.');
            }
            if (event.eventType === VrmsRepairEventType.OPENED) {
              throw this.eventConflict(
                'A repair ticket can only be opened once.',
              );
            }
            if (event.eventVersion !== state.lastEventVersion + 1) {
              throw this.eventConflict(
                'Repair event versions must arrive in sequence.',
              );
            }
            if (occurredAt.getTime() < state.lastOccurredAt.getTime()) {
              throw this.eventConflict(
                'Repair event timestamps cannot move backwards.',
              );
            }
            const previousIds = sortedIds(
              jsonStringArray(state.maintenanceScheduleIds),
            );
            if (!previousIds.every((id) => scheduleIds.includes(id))) {
              throw this.eventConflict(
                'Accepted VMMS schedule links cannot be removed.',
              );
            }
            const previousReferralIds = sortedIds(
              jsonStringArray(state.acceptedReferralIds),
            );
            if (
              !previousReferralIds.every((id) =>
                acceptedReferralIds.includes(id),
              )
            ) {
              throw this.eventConflict(
                'Accepted VMMS referrals cannot be removed from a repair ticket.',
              );
            }
            if (
              event.eventType === VrmsRepairEventType.LINKS_UPDATED &&
              previousIds.length === scheduleIds.length
            ) {
              throw this.eventConflict(
                'LINKS_UPDATED must add at least one VMMS schedule.',
              );
            }
          }

          const schedules = await this.validateLinkedSchedules(
            tx,
            scheduleIds,
            vehicle.plateNumber,
          );
          await this.acceptLinkedReferrals(
            tx,
            acceptedReferralIds,
            scheduleIds,
            vehicleId,
            repairTicketId,
            repairTicketNumber,
            repairStatus,
            outsideShopName,
          );
          if (event.eventType === VrmsRepairEventType.OPENED) {
            await tx.vrmsRepairIntegrationState.create({
              data: {
                repairTicketId,
                vehicleId,
                repairTicketNumber,
                repairStatus,
                outsideShopName,
                status: VrmsRepairIntegrationStatus.OPEN,
                lastEventVersion: event.eventVersion,
                maintenanceScheduleIds: scheduleIds,
                acceptedReferralIds,
                lastOccurredAt: occurredAt,
              },
            });
            await this.setVehicleStatus(
              tx,
              vehicleId,
              VehicleStatus.UNDER_REPAIR,
            );
          } else {
            if (event.eventType === VrmsRepairEventType.COMPLETED) {
              for (const schedule of schedules) {
                await this.maintenanceSchedules.returnToChiefForFinalVerificationFromVrmsEvent(
                  tx,
                  schedule,
                );
              }
            }

            await tx.vrmsRepairIntegrationState.update({
              where: { repairTicketId },
              data: {
                status:
                  event.eventType === VrmsRepairEventType.COMPLETED
                    ? VrmsRepairIntegrationStatus.COMPLETED
                    : event.eventType === VrmsRepairEventType.CANCELLED
                      ? VrmsRepairIntegrationStatus.CANCELLED
                      : VrmsRepairIntegrationStatus.OPEN,
                lastEventVersion: event.eventVersion,
                maintenanceScheduleIds: scheduleIds,
                acceptedReferralIds,
                repairTicketNumber,
                repairStatus,
                outsideShopName,
                lastOccurredAt: occurredAt,
              },
            });
            if (event.eventType !== VrmsRepairEventType.LINKS_UPDATED) {
              await this.recomputeVehicleStatus(
                tx,
                vehicleId,
                vehicle.plateNumber,
              );
            }
          }

          await tx.vrmsRepairEventReceipt.create({
            data: {
              eventId,
              repairTicketId,
              eventVersion: event.eventVersion,
              eventType: event.eventType,
              vmmsVehicleId: vehicleId,
              maintenanceScheduleIds: scheduleIds,
              repairTicketNumber,
              repairStatus,
              outsideShopName,
              acceptedReferralIds,
              occurredAt,
              serviceOdometerReading: event.serviceOdometerReading,
            },
          });

          return {
            accepted: true,
            duplicate: false,
            eventVersion: event.eventVersion,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw this.eventConflict(
          'The repair event conflicted with another update. Retry the same event.',
        );
      }
      throw error;
    }
  }

  async applyReferralOutcome(event: VrmsRepairReferralEventDto) {
    const eventId = event.eventId.toLowerCase();
    const referralId = event.referralId.toLowerCase();
    const occurredAt = new Date(event.occurredAt);
    const reason = event.reason.trim();
    if (!/(Z|\+00:00)$/i.test(event.occurredAt)) {
      throw new BadRequestException('occurredAt must be a UTC timestamp.');
    }
    if (!reason) {
      throw new BadRequestException('A rejection reason is required.');
    }
    if (event.eventType !== 'REJECTED') {
      throw new BadRequestException('Unsupported referral outcome.');
    }

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`referral-event:${eventId}`}, 0))
        `;
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`referral:${referralId}`}, 0))
        `;

        const receipt = await tx.vrmsRepairReferralEventReceipt.findUnique({
          where: { eventId },
        });
        if (receipt) {
          if (
            receipt.referralId === referralId &&
            receipt.eventType === event.eventType &&
            receipt.reason === reason &&
            receipt.occurredAt.getTime() === occurredAt.getTime()
          ) {
            return { accepted: true, duplicate: true };
          }
          throw new ConflictException({
            code: 'EVENT_ID_REUSED',
            message: 'This event ID was already used with a different payload.',
          });
        }

        const referral = await tx.vmmsRepairReferral.findUnique({
          where: { id: referralId },
        });
        if (!referral) {
          throw new NotFoundException({
            code: 'REPAIR_REFERRAL_NOT_FOUND',
            message: 'The VMMS repair referral was not found.',
          });
        }
        if (
          referral.status !== VmmsRepairReferralStatus.QUEUED &&
          referral.status !== VmmsRepairReferralStatus.SENT &&
          referral.status !== VmmsRepairReferralStatus.FAILED
        ) {
          throw this.eventConflict(
            'Only an unaccepted referral can be rejected.',
          );
        }
        const latestReferral = await tx.vmmsRepairReferral.findFirst({
          where: { maintenanceScheduleId: referral.maintenanceScheduleId },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (latestReferral?.id !== referral.id) {
          throw this.eventConflict(
            'A superseded referral cannot change the current work order.',
          );
        }

        const schedule = await tx.maintenanceSchedule.findUnique({
          where: { id: referral.maintenanceScheduleId },
        });
        if (!schedule || schedule.vehicleId !== (await tx.vehicle.findUnique({
          where: { id: referral.vehicleId },
          select: { plateNumber: true },
        }))?.plateNumber) {
          throw this.eventConflict(
            'The referral no longer matches its VMMS work order and vehicle.',
          );
        }
        const progress = isRecord(schedule.workOrderProgress)
          ? { ...schedule.workOrderProgress }
          : {};
        const overdueInProgress =
          schedule.status === MaintenanceStatus.OVERDUE &&
          progress['overdueFromStatus'] === MaintenanceStatus.IN_PROGRESS;
        if (
          (schedule.status !== MaintenanceStatus.IN_PROGRESS &&
            !overdueInProgress) ||
          schedule.approvalStatus !== MaintenanceApprovalStatus.FOR_REPAIR
        ) {
          throw this.eventConflict(
            'The work order is no longer waiting for this repair referral.',
          );
        }
        delete progress['overdueFromStatus'];
        progress['vrmsRejectionReason'] = reason;
        progress['rejectionRemarks'] = reason;
        const updatedSchedule = await tx.maintenanceSchedule.updateMany({
          where: {
            id: schedule.id,
            updatedAt: schedule.updatedAt,
          },
          data: {
            status: MaintenanceStatus.IN_PROGRESS,
            approvalStatus: MaintenanceApprovalStatus.REJECTED,
            workOrderProgress: progress,
          },
        });
        if (updatedSchedule.count !== 1) {
          throw this.eventConflict(
            'The work order changed while applying the referral outcome.',
          );
        }

        await tx.vmmsRepairReferral.update({
          where: { id: referralId },
          data: {
            status: VmmsRepairReferralStatus.REJECTED,
            outcomeReason: reason,
            outcomeEventId: eventId,
            outcomeOccurredAt: occurredAt,
            nextAttemptAt: null,
            failedAt: null,
            lastErrorCode: null,
          },
        });
        await tx.vrmsRepairReferralEventReceipt.create({
          data: {
            eventId,
            referralId,
            eventType: event.eventType,
            reason,
            occurredAt,
          },
        });
        return { accepted: true, duplicate: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async validateLinkedSchedules(
    tx: Prisma.TransactionClient,
    scheduleIds: string[],
    vehiclePlateNumber: string,
  ) {
    if (!scheduleIds.length) return [];

    const schedules = await tx.maintenanceSchedule.findMany({
      where: { id: { in: scheduleIds }, deletedAt: null },
    });
    if (schedules.length !== scheduleIds.length) {
      throw new NotFoundException({
        code: 'MAINTENANCE_SCHEDULE_NOT_FOUND',
        message: 'One or more linked VMMS schedules were not found.',
      });
    }
    for (const schedule of schedules) {
      if (schedule.vehicleId !== vehiclePlateNumber) {
        throw this.eventConflict(
          'Every linked VMMS schedule must belong to the repair vehicle.',
        );
      }
      if (
        (schedule.status !== MaintenanceStatus.IN_PROGRESS &&
          !(
            schedule.status === MaintenanceStatus.OVERDUE &&
            isRecord(schedule.workOrderProgress) &&
            schedule.workOrderProgress['overdueFromStatus'] ===
              MaintenanceStatus.IN_PROGRESS
          )) ||
        schedule.approvalStatus !== MaintenanceApprovalStatus.FOR_REPAIR
      ) {
        throw this.eventConflict(
          'Every linked VMMS schedule must be In Progress or overdue In Progress / For Repair.',
        );
      }
    }
    return schedules;
  }

  private async resolveOutsideShopName(
    tx: Prisma.TransactionClient,
    repairStatus: string,
    suppliedName?: string,
  ): Promise<string | null> {
    const name = suppliedName?.trim();
    if (repairStatus !== 'OUTSOURCED') {
      if (name) {
        throw this.eventConflict(
          'outsideShopName is only valid for an outsourced repair.',
        );
      }
      return null;
    }
    if (!name) {
      throw new BadRequestException(
        'An outside shop name is required for an outsourced repair.',
      );
    }
    const provider = await tx.outsourcedProvider.findFirst({
      where: {
        isActive: true,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { name: true },
    });
    if (!provider) {
      throw this.eventConflict(
        'The outside shop is not in the active VMMS provider catalog.',
      );
    }
    return provider.name;
  }

  private async acceptLinkedReferrals(
    tx: Prisma.TransactionClient,
    referralIds: string[],
    scheduleIds: string[],
    vehicleId: string,
    repairTicketId: string,
    repairTicketNumber: string,
    repairStatus: string,
    outsideShopName: string | null,
  ): Promise<void> {
    if (!referralIds.length) return;
    const referrals = await tx.vmmsRepairReferral.findMany({
      where: { id: { in: referralIds } },
    });
    if (referrals.length !== referralIds.length) {
      throw this.eventConflict(
        'One or more accepted referral IDs are unknown to VMMS.',
      );
    }
    for (const referral of referrals) {
      if (
        referral.vehicleId !== vehicleId ||
        !scheduleIds.includes(referral.maintenanceScheduleId)
      ) {
        throw this.eventConflict(
          'An accepted referral must match the repair vehicle and linked work-order set.',
        );
      }
      if (
        referral.status !== VmmsRepairReferralStatus.QUEUED &&
        referral.status !== VmmsRepairReferralStatus.SENT &&
        referral.status !== VmmsRepairReferralStatus.FAILED &&
        referral.status !== VmmsRepairReferralStatus.ACCEPTED
      ) {
        throw this.eventConflict(
          'Only a pending or already-linked referral can be accepted.',
        );
      }
      if (
        referral.repairTicketId &&
        referral.repairTicketId !== repairTicketId
      ) {
        throw this.eventConflict(
          'An accepted referral cannot be moved to another repair ticket.',
        );
      }
      await tx.vmmsRepairReferral.update({
        where: { id: referral.id },
        data: {
          status: VmmsRepairReferralStatus.ACCEPTED,
          repairTicketId,
          repairTicketNumber,
          repairStatus,
          outsideShopName,
          deliveredAt: referral.deliveredAt ?? new Date(),
          lastErrorCode: null,
        },
      });
    }
  }

  private async recomputeVehicleStatus(
    tx: Prisma.TransactionClient,
    vehicleId: string,
    vehiclePlateNumber: string,
  ): Promise<void> {
    const otherOpenRepair = await tx.vrmsRepairIntegrationState.findFirst({
      where: {
        vehicleId,
        status: VrmsRepairIntegrationStatus.OPEN,
      },
      select: { repairTicketId: true },
    });
    if (otherOpenRepair) {
      await this.setVehicleStatus(tx, vehicleId, VehicleStatus.UNDER_REPAIR);
      return;
    }

    const schedules = await tx.maintenanceSchedule.findMany({
      where: {
        vehicleId: vehiclePlateNumber,
        deletedAt: null,
        status: {
          in: [
            MaintenanceStatus.IN_PROGRESS,
            MaintenanceStatus.DONE,
            MaintenanceStatus.OVERDUE,
          ],
        },
      },
      select: { status: true, workOrderProgress: true },
    });
    const activeMaintenance = schedules.some((schedule) => {
      if (
        schedule.status === MaintenanceStatus.IN_PROGRESS ||
        schedule.status === MaintenanceStatus.DONE
      ) {
        return true;
      }
      return (
        schedule.status === MaintenanceStatus.OVERDUE &&
        isRecord(schedule.workOrderProgress) &&
        schedule.workOrderProgress['overdueFromStatus'] ===
          MaintenanceStatus.IN_PROGRESS
      );
    });
    await this.setVehicleStatus(
      tx,
      vehicleId,
      activeMaintenance
        ? VehicleStatus.UNDER_MAINTENANCE
        : VehicleStatus.AVAILABLE,
    );
  }

  private async setVehicleStatus(
    tx: Prisma.TransactionClient,
    vehicleId: string,
    status: VehicleStatus,
  ): Promise<void> {
    const vehicle = await tx.vehicle.findFirst({
      where: { id: vehicleId, isActive: true, deletedAt: null },
      select: {
        id: true,
        plateNumber: true,
        status: true,
        availabilityVersion: true,
      },
    });
    if (!vehicle) {
      throw new NotFoundException({
        code: 'VEHICLE_NOT_FOUND',
        message: 'The VMMS vehicle is no longer active.',
      });
    }
    if (vehicle.status === status) return;
    const updated = await tx.vehicle.updateMany({
      where: {
        id: vehicleId,
        isActive: true,
        deletedAt: null,
        status: vehicle.status,
      },
      data: { status, availabilityVersion: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw this.eventConflict(
        'The VMMS vehicle status changed while applying the repair event.',
      );
    }
    const savedVehicle = await tx.vehicle.findUniqueOrThrow({
      where: { id: vehicleId },
      select: {
        id: true,
        plateNumber: true,
        status: true,
        availabilityVersion: true,
      },
    });
    await this.availability.recordStatusChange(tx, savedVehicle);
  }

  private eventConflict(message: string): ConflictException {
    return new ConflictException({ code: 'INVALID_REPAIR_EVENT', message });
  }
}
