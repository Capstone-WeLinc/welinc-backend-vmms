import { BadRequestException } from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';

const ALLOWED_VMMS_ROLES = new Set<UserRole>([
  UserRole.ADMIN,
  UserRole.OPERATIONS,
  UserRole.CHIEF_MECHANIC,
  UserRole.MECHANIC,
]);

export type VmmsRoleAssignment = {
  role: UserRole;
  system: SystemType;
};

export function assertSingleVmmsRoleAssignment(
  assignments: VmmsRoleAssignment[],
): void {
  if (
    assignments.length !== 1 ||
    assignments[0].system !== SystemType.VMMS ||
    !ALLOWED_VMMS_ROLES.has(assignments[0].role)
  ) {
    throw new BadRequestException(
      'A VMMS user account must have exactly one role: Admin, Operations, Chief Mechanic, or Mechanic.',
    );
  }
}
