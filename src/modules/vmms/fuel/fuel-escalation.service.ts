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
      const anomalies = await this.prisma.fuelAnomaly.findMany({ where: { status: 'OPEN' }, include: { fillUp: { select: { isVoided: true } }, vehicle: { select: { plateNumber: true } } } });
      const now = new Date();
      for (const anomaly of anomalies) {
        if (anomaly.fillUp.isVoided) continue;
        const age = now.getTime() - anomaly.createdAt.getTime();
        const stages = [
          { days: 7, field: 'notifiedDay7At' as const, roles: ['CHIEF_MECHANIC', 'ADMIN', 'OPERATIONS'], label: 'Critical fuel anomaly' },
          { days: 3, field: 'notifiedDay3At' as const, roles: ['ADMIN', 'OPERATIONS'], label: 'Fuel anomaly follow-up due' },
          { days: 1, field: 'notifiedDay1At' as const, roles: ['CHIEF_MECHANIC'], label: 'Fuel anomaly follow-up due' },
        ];
        for (const stage of stages) {
          if (age < stage.days * 86400000 || anomaly[stage.field]) continue;
          const recipients = await this.prisma.user.findMany({ where: { isActive: true, deletedAt: null, roles: { some: { system: 'VMMS', role: { in: stage.roles as any } } } }, select: { id: true } });
          await this.prisma.$transaction(async (tx) => {
            if (recipients.length) await tx.notification.createMany({ data: recipients.map((user) => ({ userId: user.id, title: stage.label, message: `${anomaly.vehicle.plateNumber} has an unresolved fuel-efficiency anomaly${anomaly.note ? `: ${anomaly.note}` : '. No resolution note has been entered.'}`, type: 'warning' })) });
            await tx.fuelAnomaly.update({ where: { id: anomaly.id }, data: { [stage.field]: now } });
          });
        }
      }
    } catch (error) {
      this.logger.error('Fuel anomaly escalation failed.', error instanceof Error ? error.stack : undefined);
    }
  }
}
