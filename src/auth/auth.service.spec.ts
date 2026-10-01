import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService.getAuditLogs', () => {
  const date = new Date('2026-10-01T10:00:00.000Z');
  const prisma = {
    loginActivity: { findMany: jest.fn() },
    vehicleAuditLog: { findMany: jest.fn() },
    auditLog: { findMany: jest.fn() },
    maintenanceScheduleCancellation: { findMany: jest.fn() },
  };
  const service = new AuthService(prisma as never, {} as never, {} as never, {} as never, {} as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.loginActivity.findMany.mockResolvedValue([
      { id: 'login-id', email: 'admin@example.com', event: 'SUCCESSFUL_LOGIN', ipAddress: null, deviceType: 'Desktop', createdAt: date },
    ]);
    prisma.vehicleAuditLog.findMany.mockResolvedValue([
      { id: 'vehicle-id', email: 'ops@example.com', action: 'FIELD_UPDATED', fieldName: 'model', previousValue: 'A', newValue: 'B', createdAt: new Date(date.getTime() + 1000), vehicle: { plateNumber: 'ABC-123' } },
    ]);
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.maintenanceScheduleCancellation.findMany.mockResolvedValue([]);
  });

  it('combines sources, sorts newest first, and returns a normalized record shape', async () => {
    const result = await service.getAuditLogs();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ source: 'vehicle', actor: 'ops@example.com', entity: 'ABC-123', details: 'model', previousValue: 'A', newValue: 'B' });
    expect(result[1]).toMatchObject({ source: 'login', action: 'SUCCESSFUL_LOGIN', actor: 'admin@example.com' });
    expect(prisma.loginActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
  });

  it('loads only the selected source', async () => {
    await service.getAuditLogs('login');
    expect(prisma.loginActivity.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleAuditLog.findMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('rejects unsupported source filters', async () => {
    await expect(service.getAuditLogs('unknown')).rejects.toBeInstanceOf(BadRequestException);
  });
});
