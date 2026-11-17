import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';
import { assertSingleVmmsRoleAssignment } from './vmms-role-assignments';

describe('assertSingleVmmsRoleAssignment', () => {
  it.each([
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.CHIEF_MECHANIC,
    UserRole.MECHANIC,
  ])('accepts the VMMS role %s', (role) => {
    expect(() =>
      assertSingleVmmsRoleAssignment([{ role, system: SystemType.VMMS }]),
    ).not.toThrow();
  });

  it('rejects an empty assignment list', () => {
    expect(() => assertSingleVmmsRoleAssignment([])).toThrow(
      BadRequestException,
    );
  });

  it('rejects multiple roles', () => {
    expect(() =>
      assertSingleVmmsRoleAssignment([
        { role: UserRole.ADMIN, system: SystemType.VMMS },
        { role: UserRole.OPERATIONS, system: SystemType.VMMS },
      ]),
    ).toThrow(BadRequestException);
  });

  it('rejects roles outside the four VMMS roles', () => {
    expect(() =>
      assertSingleVmmsRoleAssignment([
        { role: 'CUSTOMER_SUPPORT' as UserRole, system: SystemType.VMMS },
      ]),
    ).toThrow(BadRequestException);
  });

  it('rejects an assignment for another system', () => {
    expect(() =>
      assertSingleVmmsRoleAssignment([
        { role: UserRole.ADMIN, system: SystemType.VRMS },
      ]),
    ).toThrow(BadRequestException);
  });
});
