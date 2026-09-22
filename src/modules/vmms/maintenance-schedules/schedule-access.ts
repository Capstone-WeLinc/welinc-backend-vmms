import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface ScheduleActor {
  sub: string;
  roles: { role: string; system: string }[];
  system?: string;
}

export function scheduleScope(actor: ScheduleActor): Prisma.MaintenanceScheduleWhereInput {
  if (!actor?.sub || (actor.system && actor.system !== 'VMMS')) throw new ForbiddenException();
  const roles = actor.roles.filter((r) => r.system === 'VMMS').map((r) => r.role);
  if (roles.includes('ADMIN') || roles.includes('OPERATIONS')) return {};
  if (roles.includes('CHIEF_MECHANIC')) return { chiefMechanicId: actor.sub };
  if (roles.includes('MECHANIC')) return { assignedMechanicId: actor.sub };
  throw new ForbiddenException();
}
