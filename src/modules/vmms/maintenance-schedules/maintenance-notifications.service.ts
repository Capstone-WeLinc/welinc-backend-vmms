import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../shared/prisma.service';
import { scheduleEvents, ScheduleEvent } from './schedule-events';

@Injectable()
export class MaintenanceNotificationsService {
  private readonly logger = new Logger(MaintenanceNotificationsService.name);
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  @Cron('*/1 * * * *', { waitForCompletion: true })
  async evaluate() {
    try {
      const schedules = await this.prisma.maintenanceSchedule.findMany({
        where: { deletedAt: null, status: { notIn: ['COMPLETED', 'CANCELLED'] }, assignedMechanicId: { not: null } },
        include: { assignedMechanicUser: { include: { roles: true } } },
      });
      const vehicles = await this.prisma.vehicle.findMany({ where: { deletedAt: null }, select: { id: true, plateNumber: true, odometer: true } });
      const readings = new Map(vehicles.flatMap((v) => [[v.id, v.odometer], [v.plateNumber, v.odometer]] as [string, number][]));
      const descriptions: Record<ScheduleEvent, string> = {
        CREATED: 'A maintenance work order has been assigned to you',
        DUE: 'Maintenance is due', OVERDUE: 'Maintenance is overdue',
        ODOMETER_BUFFER: 'Maintenance is approaching its odometer limit',
      };
      for (const schedule of schedules) {
        const user = schedule.assignedMechanicUser;
        if (!user?.isActive || user.deletedAt || !user.roles.some((r) => r.system === 'VMMS' && r.role === 'MECHANIC')) continue;
        for (const kind of scheduleEvents(schedule, readings.get(schedule.vehicleId) ?? null)) {
          await this.prisma.maintenanceNotification.upsert({
            where: { userId_scheduleId_kind: { userId: user.id, scheduleId: schedule.id, kind } },
            update: {},
            create: { userId: user.id, scheduleId: schedule.id, kind, message: `${descriptions[kind]}: ${schedule.title} (${schedule.vehicleId}).` },
          });
        }
      }
      await this.deliverPending();
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

  async deliverPending() {
    // No messages leave the server unless live delivery is explicitly configured.
    if (this.config.get<string>('SEMAPHORE_DRY_RUN', 'true') !== 'false') return;
    const apiKey = this.config.get<string>('SEMAPHORE_API_KEY');
    if (!apiKey || apiKey.includes('your_')) return;
    const pending = await this.prisma.maintenanceNotification.findMany({
      where: { smsStatus: 'PENDING', user: { isActive: true, deletedAt: null, roles: { some: { role: 'MECHANIC', system: 'VMMS' } } }, schedule: { deletedAt: null, status: { notIn: ['COMPLETED', 'CANCELLED'] } } },
      include: { user: true, schedule: true }, orderBy: { createdAt: 'asc' }, take: 30,
    });
    for (const notification of pending) {
      const number = notification.user.contact?.replace(/[\s()+-]/g, '') ?? '';
      if (notification.schedule.assignedMechanicId !== notification.userId || !/^(09\d{9}|639\d{9})$/.test(number)) continue;
      // Atomic claim prevents concurrent workers from sending the same event.
      const claim = await this.prisma.maintenanceNotification.updateMany({ where: { id: notification.id, smsStatus: 'PENDING' }, data: { smsStatus: 'SENDING' } });
      if (!claim.count) continue;
      try {
        const body = new URLSearchParams({ apikey: apiKey, number, message: notification.message });
        const sender = this.config.get<string>('SEMAPHORE_SENDER_NAME');
        if (sender) body.set('sendername', sender);
        const response = await fetch('https://api.semaphore.co/api/v4/messages', { method: 'POST', body, signal: AbortSignal.timeout(15000) });
        const result: unknown = await response.json();
        const item = Array.isArray(result) ? result[0] as { message_id?: string | number; status?: string } : null;
        const accepted = response.ok && item?.message_id != null && ['queued', 'pending', 'sent'].includes(item.status?.toLowerCase() ?? '');
        await this.prisma.maintenanceNotification.update({ where: { id: notification.id }, data: {
          smsStatus: accepted ? 'ACCEPTED' : 'FAILED', smsProviderId: item?.message_id != null ? String(item.message_id) : null,
        } });
      } catch {
        // A timeout may occur after acceptance. Do not automatically duplicate an SMS.
        await this.prisma.maintenanceNotification.update({ where: { id: notification.id }, data: { smsStatus: 'UNKNOWN' } });
        this.logger.warn(`SMS delivery needs review for notification ${notification.id}`);
      }
    }
  }
}
