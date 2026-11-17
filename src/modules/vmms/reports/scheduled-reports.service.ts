import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';

type ReportType = 'daily-operations' | 'monthly-costs';
type JsonData = Prisma.InputJsonValue;

function manilaDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as {
    year: string; month: string; day: string;
  };
}

function utcMonthRange(year: number, month: number) {
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

function isUniqueConflict(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}

@Injectable()
export class ScheduledReportsService {
  private readonly logger = new Logger(ScheduledReportsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listScheduledReports() {
    return this.prisma.scheduledFleetReport.findMany({
      orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { id: true, reportType: true, periodKey: true, data: true, generatedAt: true },
    });
  }

  @Cron('0 7 * * *', { timeZone: 'Asia/Manila', waitForCompletion: true })
  async generateScheduledReports(): Promise<void> {
    const { year, month, day } = manilaDateParts(new Date());
    try {
      await this.generateDailyReport(`${year}-${month}-${day}`);
      if (day === '01') await this.generateMonthlyReport(Number(year), Number(month));
    } catch (error) {
      this.logger.error('Scheduled fleet report generation failed.', error instanceof Error ? error.stack : undefined);
    }
  }

  private async generateDailyReport(periodKey: string): Promise<void> {
    const [overdueWorkOrders, vehiclesUnderMaintenance, openFuelAnomalies] = await Promise.all([
      this.prisma.maintenanceSchedule.count({ where: { deletedAt: null, status: 'OVERDUE' } }),
      this.prisma.vehicle.count({ where: { deletedAt: null, status: 'UNDER_MAINTENANCE' } }),
      this.prisma.fuelAnomaly.count({ where: { status: 'OPEN', fillUp: { isVoided: false } } }),
    ]);
    const data = { overdueWorkOrders, vehiclesUnderMaintenance, openFuelAnomalies };
    const message = `Daily fleet summary (${periodKey}): ${overdueWorkOrders} overdue work orders, ${vehiclesUnderMaintenance} vehicles under maintenance, ${openFuelAnomalies} open fuel anomalies.`;
    await this.persistAndNotify('daily-operations', periodKey, data, message);
  }

  private async generateMonthlyReport(year: number, month: number): Promise<void> {
    const reportMonth = month === 1 ? 12 : month - 1;
    const reportYear = month === 1 ? year - 1 : year;
    const { start, end } = utcMonthRange(reportYear, reportMonth);
    const periodKey = `${reportYear}-${String(reportMonth).padStart(2, '0')}`;
    const [maintenance, fuel] = await Promise.all([
      this.prisma.maintenanceSchedule.aggregate({
        where: { deletedAt: null, status: 'COMPLETED', completedAt: { gte: start, lt: end } },
        _sum: { partsCost: true, laborCost: true, totalCost: true },
      }),
      this.prisma.fuelFillUp.aggregate({
        where: { isVoided: false, entryDate: { gte: start, lt: end } },
        _sum: { totalCost: true },
      }),
    ]);
    const data = {
      period: periodKey,
      currency: 'PHP',
      maintenancePartsCost: maintenance._sum.partsCost?.toString() ?? '0.00',
      maintenanceLaborCost: maintenance._sum.laborCost?.toString() ?? '0.00',
      maintenanceTotalCost: maintenance._sum.totalCost?.toString() ?? '0.00',
      fuelTotalCost: fuel._sum.totalCost?.toString() ?? '0.00',
    };
    const message = `Fleet cost summary (${periodKey}, PHP): maintenance ${data.maintenanceTotalCost} (parts ${data.maintenancePartsCost}, labor ${data.maintenanceLaborCost}); fuel ${data.fuelTotalCost}.`;
    await this.persistAndNotify('monthly-costs', periodKey, data, message);
  }

  private async persistAndNotify(
    reportType: ReportType,
    periodKey: string,
    data: JsonData,
    message: string,
  ): Promise<void> {
    const recipients = await this.prisma.vmmsPerson.findMany({
      where: {
        isActive: true,
        deleted: false,
        erased: false,
        roles: { hasSome: ['ADMIN', 'OPERATIONS'] },
      },
      select: { authUserId: true, roles: true, temporaryRoles: true },
    });
    const eligibleRecipients = recipients.filter((person) =>
      person.roles.some((role) => ['ADMIN', 'OPERATIONS'].includes(role) && !person.temporaryRoles.includes(role)),
    );
    const title = reportType === 'daily-operations' ? 'Daily fleet report' : 'Monthly fleet cost report';

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.scheduledFleetReport.create({ data: { reportType, periodKey, data } });
        if (eligibleRecipients.length) {
          await tx.notification.createMany({
            data: eligibleRecipients.map((recipient) => ({
              userId: recipient.authUserId,
              title,
              message,
              type: 'info',
              dedupeKey: `scheduled-report:${reportType}:${periodKey}:${recipient.authUserId}`,
            })),
            skipDuplicates: true,
          });
        }
      });
      this.logger.log(`Generated ${reportType} report for ${periodKey} and notified ${eligibleRecipients.length} user(s).`);
    } catch (error) {
      if (isUniqueConflict(error)) return;
      throw error;
    }
  }
}
