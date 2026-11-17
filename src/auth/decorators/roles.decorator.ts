import { SetMetadata } from '@nestjs/common';
import { SystemType } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const ROLE_SYSTEM_KEY = 'roleSystem';

export const RoleSystem = (system: SystemType) =>
  SetMetadata(ROLE_SYSTEM_KEY, system);

export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
