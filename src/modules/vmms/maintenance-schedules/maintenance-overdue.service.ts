import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MaintenanceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { scheduleDue } from './schedule-due';

@Injectable()
export class MaintenanceOverdueService {
  private readonly logger = new Logger(MaintenanceOverdueService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 0 * * *', { timeZone: 'Asia/Manila', waitForCompletion: true })
  async evaluateAtMidnight() {
    try {
      const count = await this.markOverdue(new Date());
      if (count) this.logger.log(`Marked ${count} maintenance work order(s) overdue.`);
    } catch (error) {
      this.logger.error('Daily maintenance overdue evaluation failed.', error instanceof Error ? error.stack : undefined);
    }
  }

  async markOverdue(now = new Date()): Promise<number> {
    const todayInManila = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const candidates = await this.prisma.maintenanceSchedule.findMany({
      where: {
        deletedAt: null,
        status: { in: [MaintenanceStatus.PENDING, MaintenanceStatus.DUE, MaintenanceStatus.IN_PROGRESS] },
      },
    });

    let overdueCount = 0;
    for (const schedule of candidates) {
      const dueDate = scheduleDue(schedule).dueDate;
      if (!dueDate || dueDate >= todayInManila) continue;
      const changed = await this.prisma.maintenanceSchedule.updateMany({
        where: { id: schedule.id, status: schedule.status, updatedAt: schedule.updatedAt, deletedAt: null },
        data: {
          status: MaintenanceStatus.OVERDUE,
          workOrderProgress: {
            ...(schedule.workOrderProgress && typeof schedule.workOrderProgress === 'object' && !Array.isArray(schedule.workOrderProgress)
              ? schedule.workOrderProgress as Record<string, unknown>
              : {}),
            overdueFromStatus: schedule.status,
            overdueAt: now.toISOString(),
          } as Prisma.InputJsonObject,
        },
      });
      overdueCount += changed.count;
    }
    return overdueCount;
  }
}
