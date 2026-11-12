import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../shared/prisma.service';

@Injectable()
export class FuelEscalationService {
  private readonly logger = new Logger(FuelEscalationService.name);
  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 0 * * *', { timeZone: 'Asia/Manila', waitForCompletion: true })
  async evaluate() {
    try {
      const anomalies = await this.prisma.fuelAnomaly.findMany({ where: { status: 'OPEN', fillUp: { isVoided: false } }, include: { vehicle: { select: { plateNumber: true } } } });
      const now = new Date();
      for (const anomaly of anomalies) {
        const age = now.getTime() - anomaly.createdAt.getTime();
        const stages = [
          { days: 1, field: 'notifiedDay1At' as const, roles: ['CHIEF_MECHANIC'], label: 'Fuel anomaly Day 1 follow-up' },
          { days: 3, field: 'notifiedDay3At' as const, roles: ['ADMIN', 'OPERATIONS'], label: 'Fuel anomaly Day 3 report due' },
          { days: 7, field: 'notifiedDay7At' as const, roles: ['CHIEF_MECHANIC', 'ADMIN', 'OPERATIONS'], label: 'Critical fuel anomaly' },
        ] as const;
        for (const stage of stages) {
          if (age < stage.days * 86400000 || anomaly[stage.field]) continue;
          const recipients = await this.prisma.user.findMany({ where: { isActive: true, deletedAt: null, roles: { some: { system: 'VMMS', role: { in: stage.roles as any } } } }, select: { id: true } });
          await this.prisma.$transaction(async (tx) => {
            // Claim this escalation stage atomically so overlapping workers
            // cannot send duplicate notifications for the same anomaly.
            const claimed = await tx.fuelAnomaly.updateMany({
              where: { id: anomaly.id, status: 'OPEN', [stage.field]: null },
              data: { [stage.field]: now },
            });
            if (!claimed.count || !recipients.length) return;

            // Re-read at send time so Day 3 recipients get the latest note and
            // reports attached after the anomaly was first flagged.
            const current = await tx.fuelAnomaly.findUnique({
              where: { id: anomaly.id },
              include: { fillUp: { select: { isVoided: true } }, attachments: { select: { name: true } } },
            });
            if (!current || current.status !== 'OPEN' || current.fillUp.isVoided) return;

            const note = current.note?.trim() || 'No resolution note has been entered.';
            const attachmentNames = current.attachments.map((attachment) => attachment.name);
            const reportSummary = stage.days >= 3
              ? ` Report attachment${attachmentNames.length === 1 ? '' : 's'}: ${attachmentNames.length ? attachmentNames.join(', ') : 'none uploaded'}. Admin and Operations can review this anomaly in Fuel Management and download available reports.`
              : '';
            const message = `${anomaly.vehicle.plateNumber} has an unresolved fuel-efficiency anomaly (Day ${stage.days}). Operations note: ${note}.${reportSummary}`;
            await tx.notification.createMany({ data: recipients.map((user) => ({ userId: user.id, title: stage.label, message, type: 'warning' })) });
          });
        }
      }
    } catch (error) {
      this.logger.error('Fuel anomaly escalation failed.', error instanceof Error ? error.stack : undefined);
    }
  }
}
