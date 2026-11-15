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
        where: { deletedAt: null, status: { notIn: ['COMPLETED', 'CANCELLED'] }, assignedMechanicId: { not: null } },
      });
      const vehicles = await this.prisma.vehicle.findMany({ where: { deletedAt: null }, select: { id: true, plateNumber: true, odometer: true } });
      const readings = new Map(vehicles.flatMap((v) => [[v.id, v.odometer], [v.plateNumber, v.odometer]] as [string, number][]));
      const descriptions: Record<ScheduleEvent, string> = {
        CREATED: 'A maintenance work order has been assigned to you',
        DUE: 'Maintenance is due', OVERDUE: 'Maintenance is overdue',
        ODOMETER_BUFFER: 'Maintenance is approaching its odometer limit',
      };
      for (const schedule of schedules) {
        const user = await this.prisma.mechanic.findUnique({ where: { userId: schedule.assignedMechanicId! } });
        if (!user?.isActive || user.role !== 'MECHANIC') continue;
        for (const kind of scheduleEvents(schedule, readings.get(schedule.vehicleId) ?? null)) {
          await this.prisma.maintenanceNotification.upsert({
            where: { userId_scheduleId_kind: { userId: user.userId!, scheduleId: schedule.id, kind } },
            update: {},
            create: { userId: user.userId!, scheduleId: schedule.id, kind, message: `${descriptions[kind]}: ${schedule.title} (${schedule.vehicleId}).` },
          });
        }
      }
    } catch {
      this.logger.error('Maintenance notification evaluation failed; check database migrations and connectivity.');
    }
  }

  async list(userId: string) {
    return this.prisma.maintenanceNotification.findMany({
      where: { userId, schedule: { deletedAt: null, assignedMechanicId: userId } },
      select: { id: true, scheduleId: true, kind: true, message: true, createdAt: true, readAt: true },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  }

  async markRead(userId: string, id: string) {
    const result = await this.prisma.maintenanceNotification.updateMany({
      where: { id, userId, readAt: null, schedule: { deletedAt: null, assignedMechanicId: userId } },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

}
