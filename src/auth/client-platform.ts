import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';

export type ClientPlatform = 'web' | 'mobile';

export type PlatformRoleAssignment = {
  role: UserRole;
  system: SystemType;
};

export function getClientPlatform(headerValue: unknown): ClientPlatform {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof value === 'string' && value.toLowerCase() === 'mobile'
    ? 'mobile'
    : 'web';
}

export function assertTokenPlatform(
  requestPlatform: ClientPlatform,
  tokenPlatform?: string,
): void {
  if (
    tokenPlatform !== undefined &&
    tokenPlatform !== 'web' &&
    tokenPlatform !== 'mobile'
  ) {
    throw new UnauthorizedException('Invalid session');
  }
  if (tokenPlatform && tokenPlatform !== requestPlatform) {
    throw new UnauthorizedException('Invalid session');
  }
}

export function assertVmmsPlatformAccess(
  roles: PlatformRoleAssignment[],
  platform: ClientPlatform,
): void {
  const vmmsRoles = roles
    .filter((assignment) => assignment.system === SystemType.VMMS)
    .map((assignment) => assignment.role);
  const hasMechanicRole = vmmsRoles.some(
    (role) => role === UserRole.MECHANIC || role === UserRole.CHIEF_MECHANIC,
  );
  const hasWebRole = vmmsRoles.some(
    (role) => role === UserRole.ADMIN || role === UserRole.OPERATIONS,
  );

  if (platform === 'web' && hasMechanicRole) {
    throw new ForbiddenException(
      'Mechanic and Chief Mechanic accounts can only access VMMS on mobile.',
    );
  }

  if (platform === 'mobile' && (!hasMechanicRole || hasWebRole)) {
    throw new ForbiddenException(
      'Only Mechanic and Chief Mechanic accounts can access VMMS on mobile.',
    );
  }
}
