import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../shared/prisma.service';
import { scheduleEvents, ScheduleEvent } from './schedule-events';

@Injectable()
export class MaintenanceNotificationsService {
  private readonly logger = new Logger(MaintenanceNotificationsService.name);
  constructor(private readonly prisma: PrismaService) {}

  @Cron('*/1 * * * *', { waitForCompletion: true })
  async evaluate() {
    try {
      const schedules = await this.prisma.maintenanceSchedule.findMany({
        where: {
          deletedAt: null,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
          assignedMechanicId: { not: null },
        },
      });
      const vehicles = await this.prisma.vehicle.findMany({
        where: { deletedAt: null },
        select: { id: true, plateNumber: true, odometer: true },
      });
      const readings = new Map(
        vehicles.flatMap(
          (v) =>
            [
              [v.id, v.odometer],
              [v.plateNumber, v.odometer],
            ] as [string, number][],
        ),
      );
      const descriptions: Record<ScheduleEvent, string> = {
        CREATED: 'A maintenance work order has been assigned to you',
        DUE: 'Maintenance is due',
        OVERDUE: 'Maintenance is overdue',
        ODOMETER_BUFFER: 'Maintenance is approaching its odometer limit',
      };
      for (const schedule of schedules) {
        const user = await this.prisma.mechanic.findUnique({
          where: { userId: schedule.assignedMechanicId! },
        });
        if (!user?.isActive || user.role !== 'MECHANIC') continue;
        for (const kind of scheduleEvents(
          schedule,
          readings.get(schedule.vehicleId) ?? null,
        )) {
          await this.prisma.maintenanceNotification.upsert({
            where: {
              userId_scheduleId_kind: {
                userId: user.userId!,
                scheduleId: schedule.id,
                kind,
              },
            },
            update: {},
            create: {
              userId: user.userId!,
              scheduleId: schedule.id,
              kind,
              message: `${descriptions[kind]}: ${schedule.title} (${schedule.vehicleId}).`,
            },
          });
        }
      }
    } catch {
      this.logger.error(
        'Maintenance notification evaluation failed; check database migrations and connectivity.',
      );
    }
  }

  @Cron('0 7 * * *', { timeZone: 'Asia/Manila', waitForCompletion: true })
  async evaluateOverdueEscalations() {
    try {
      const evaluationTime = Date.now();
      const overdue = await this.prisma.maintenanceSchedule.findMany({
        where: { deletedAt: null, status: 'OVERDUE' },
      });
      const people = await this.prisma.vmmsPerson.findMany({
        where: { isActive: true, deleted: false, erased: false },
        select: { authUserId: true, roles: true, temporaryRoles: true },
      });
      const stages = [
        {
          days: 1,
          roles: ['CHIEF_MECHANIC'],
          title: 'Maintenance overdue follow-up',
          critical: false,
        },
        {
          days: 3,
          roles: ['ADMIN', 'OPERATIONS'],
          title: 'Maintenance overdue escalation',
          critical: false,
        },
        {
          days: 7,
          roles: ['ADMIN', 'OPERATIONS', 'CHIEF_MECHANIC'],
          title: 'Critical maintenance escalation',
          critical: true,
        },
      ] as const;

      for (const schedule of overdue) {
        const progress =
          schedule.workOrderProgress &&
          typeof schedule.workOrderProgress === 'object' &&
          !Array.isArray(schedule.workOrderProgress)
            ? (schedule.workOrderProgress as Record<string, unknown>)
            : {};
        const overdueAt =
          typeof progress.overdueAt === 'string'
            ? Date.parse(progress.overdueAt)
            : (schedule.targetDueDate?.getTime() ??
              schedule.updatedAt.getTime());
        if (!Number.isFinite(overdueAt)) continue;
        const daysOverdue = Math.floor(
          (evaluationTime - overdueAt) / 86_400_000,
        );
        for (const stage of stages) {
          if (daysOverdue < stage.days) continue;
          const recipients = people.filter((person) =>
            person.roles.some(
              (role) =>
                (stage.roles as readonly string[]).includes(role) &&
                !person.temporaryRoles.includes(role),
            ),
          );
          if (!recipients.length) continue;
          const workOrder = schedule.workOrderNumber || schedule.title;
          await this.prisma.notification.createMany({
            data: recipients.map((person) => ({
              userId: person.authUserId,
              maintenanceScheduleId: schedule.id,
              title: stage.title,
              message: `${stage.critical ? 'Critical: ' : ''}${workOrder} is ${daysOverdue} day(s) overdue. The work-order status remains ${schedule.status}.`,
              type: 'warning',
              dedupeKey: `maintenance-escalation:${schedule.id}:day-${stage.days}:${person.authUserId}`,
            })),
            skipDuplicates: true,
          });
        }
      }
    } catch (error) {
      this.logger.error(
        'Maintenance overdue escalation failed.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async list(userId: string) {
    return this.prisma.maintenanceNotification.findMany({
      where: {
        userId,
        schedule: { deletedAt: null, assignedMechanicId: userId },
      },
      select: {
        id: true,
        scheduleId: true,
        kind: true,
        message: true,
        createdAt: true,
        readAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async markRead(userId: string, id: string) {
    const result = await this.prisma.maintenanceNotification.updateMany({
      where: {
        id,
        userId,
        readAt: null,
        schedule: { deletedAt: null, assignedMechanicId: userId },
      },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}
