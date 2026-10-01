import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SystemType, UserRole } from '@prisma/client';
import { AuthService } from './auth.service';

describe('Refresh token sessions', () => {
  const refreshToken = 'raw-refresh-token-from-secure-client-storage';
  const storedToken = {
    id: 'refresh-row-1',
    userId: 'user-1',
    tokenHash: 'hashed-refresh-token',
    clientPlatform: 'mobile',
    expiresAt: new Date(Date.now() + 60_000),
  };
  const transaction = {
    refreshToken: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    refreshToken: {
      findUnique: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findFirst: jest.fn() },
    $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) => callback(transaction)),
  };
  const jwt = { sign: jest.fn().mockReturnValue('new-access-token') };
  const config = { get: jest.fn().mockReturnValue('7d') };
  const service = new AuthService(prisma as never, jwt as unknown as JwtService, {} as never, config as never, {} as never);

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken);
    prisma.user.findFirst.mockResolvedValue({
      id: 'user-1',
      email: 'mechanic@example.test',
      isActive: true,
      lockedAt: null,
      roles: [{ role: UserRole.MECHANIC, system: SystemType.VMMS }],
    });
  });

  it('checks a hash, rotates the stored credential, and returns a new access token', async () => {
    const result = await service.refreshSession(refreshToken, 'mobile');

    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).not.toBe(refreshToken);
    expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: expect.any(String) },
    });
    expect(prisma.refreshToken.findUnique.mock.calls[0][0].where.tokenHash).not.toBe(refreshToken);
    expect(transaction.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { id: 'refresh-row-1', tokenHash: expect.any(String), expiresAt: { gt: expect.any(Date) } },
    });
    expect(transaction.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', clientPlatform: 'mobile', tokenHash: expect.any(String), expiresAt: expect.any(Date) }),
    });
    expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({ sub: 'user-1', clientPlatform: 'mobile' }));
  });

  it('rejects a refresh token issued for a different client platform', async () => {
    await expect(service.refreshSession(refreshToken, 'web')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a token that was already rotated', async () => {
    transaction.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.refreshSession(refreshToken, 'mobile')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(transaction.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects and removes an expired refresh token', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({ ...storedToken, expiresAt: new Date(0) });
    await expect(service.refreshSession(refreshToken, 'mobile')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { id: 'refresh-row-1' } });
  });
});
