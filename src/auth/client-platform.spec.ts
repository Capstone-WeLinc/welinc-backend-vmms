import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';
import {
  assertTokenPlatform,
  assertVmmsPlatformAccess,
  getClientPlatform,
} from './client-platform';

const vmmsRole = (role: UserRole) => [{ role, system: SystemType.VMMS }];

describe('VMMS client platform access', () => {
  it.each([UserRole.MECHANIC, UserRole.CHIEF_MECHANIC])(
    'rejects %s from web',
    (role) => {
      expect(() => assertVmmsPlatformAccess(vmmsRole(role), 'web')).toThrow(
        ForbiddenException,
      );
    },
  );

  it.each([UserRole.ADMIN, UserRole.OPERATIONS])(
    'allows %s on web',
    (role) => {
      expect(() => assertVmmsPlatformAccess(vmmsRole(role), 'web')).not.toThrow();
    },
  );

  it.each([UserRole.MECHANIC, UserRole.CHIEF_MECHANIC])(
    'allows %s on mobile',
    (role) => {
      expect(() => assertVmmsPlatformAccess(vmmsRole(role), 'mobile')).not.toThrow();
    },
  );

  it.each([UserRole.ADMIN, UserRole.OPERATIONS])(
    'rejects %s from mobile',
    (role) => {
      expect(() => assertVmmsPlatformAccess(vmmsRole(role), 'mobile')).toThrow(
        ForbiddenException,
      );
    },
  );

  it('allows other-system roles on web and rejects them from VMMS mobile', () => {
    expect(() =>
      assertVmmsPlatformAccess(
        [{ role: UserRole.ADMIN, system: SystemType.BMS }],
        'mobile',
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertVmmsPlatformAccess(
        [{ role: UserRole.ADMIN, system: SystemType.VRMS }],
        'web',
      ),
    ).not.toThrow();
  });

  it('treats missing or unknown client headers as web', () => {
    expect(getClientPlatform(undefined)).toBe('web');
    expect(getClientPlatform('desktop')).toBe('web');
    expect(getClientPlatform('MOBILE')).toBe('mobile');
  });

  it('binds signed tokens to the platform that issued them', () => {
    expect(() => assertTokenPlatform('web', 'mobile')).toThrow(
      UnauthorizedException,
    );
    expect(() => assertTokenPlatform('mobile', 'mobile')).not.toThrow();
    expect(() => assertTokenPlatform('web')).not.toThrow();
  });
});
