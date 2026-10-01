import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SystemType, UserRole } from '@prisma/client';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
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
    expect(() => assertSingleVmmsRoleAssignment([])).toThrow(BadRequestException);
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

  it('rejects multiple roles in the account creation DTO', async () => {
    const dto = plainToInstance(CreateUserDto, {
      name: 'Morgan Cruz',
      email: 'morgan@example.com',
      roleAssignments: [
        { role: UserRole.ADMIN, system: SystemType.VMMS },
        { role: UserRole.OPERATIONS, system: SystemType.VMMS },
      ],
    });
    const errors = await validate(dto);
    expect(
      errors.find((error) => error.property === 'roleAssignments')?.constraints,
    ).toMatchObject({
      arrayMaxSize: 'A user account must have exactly one role.',
    });
  });

  it('rejects multiple roles in the account update DTO', async () => {
    const dto = plainToInstance(UpdateUserDto, {
      roleAssignments: [
        { role: UserRole.ADMIN, system: SystemType.VMMS },
        { role: UserRole.OPERATIONS, system: SystemType.VMMS },
      ],
    });
    const errors = await validate(dto);
    expect(
      errors.find((error) => error.property === 'roleAssignments')?.constraints,
    ).toMatchObject({
      arrayMaxSize: 'A user account must have exactly one role.',
    });
  });
});
