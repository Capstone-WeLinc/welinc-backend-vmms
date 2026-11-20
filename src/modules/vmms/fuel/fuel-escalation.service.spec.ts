import { FuelEscalationService } from './fuel-escalation.service';

describe('FuelEscalationService', () => {
  it('does not consume escalation stages before eligible recipients exist', async () => {
    const anomaly: any = {
      id: 'anomaly-id',
      status: 'OPEN',
      createdAt: new Date(Date.now() - 8 * 86400000),
      notifiedDay1At: null,
      notifiedDay3At: null,
      notifiedDay7At: null,
      note: null,
      vehicle: { plateNumber: 'TEST-123' },
    };
    let people: Array<{
      authUserId: string;
      roles: string[];
      temporaryRoles: string[];
    }> = [];
    const notifications: Array<{ title: string; message: string }> = [];
    const tx = {
      fuelAnomaly: {
        updateMany: jest.fn(async ({ data }: any) => {
          const [field, value] = Object.entries(data)[0] as [string, Date];
          if (anomaly[field]) return { count: 0 };
          anomaly[field] = value;
          return { count: 1 };
        }),
        findUnique: jest.fn(async () => ({
          ...anomaly,
          fillUp: { isVoided: false },
          attachments: [],
        })),
      },
      notification: {
        createMany: jest.fn(async ({ data }: any) => {
          notifications.push(...data);
          return { count: data.length };
        }),
      },
    };
    const prisma = {
      fuelAnomaly: { findMany: jest.fn().mockResolvedValue([anomaly]) },
      vmmsPerson: { findMany: jest.fn(async () => people) },
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new FuelEscalationService(prisma as any);

    await service.evaluate();

    expect(tx.fuelAnomaly.updateMany).not.toHaveBeenCalled();
    expect(tx.notification.createMany).not.toHaveBeenCalled();
    expect(anomaly.notifiedDay1At).toBeNull();
    expect(anomaly.notifiedDay3At).toBeNull();
    expect(anomaly.notifiedDay7At).toBeNull();

    people = [
      {
        authUserId: 'eligible-user',
        roles: ['CHIEF_MECHANIC', 'ADMIN', 'OPERATIONS'],
        temporaryRoles: [],
      },
    ];
    await service.evaluate();

    expect(tx.fuelAnomaly.updateMany).toHaveBeenCalledTimes(3);
    expect(notifications.map(({ title }) => title)).toEqual([
      'Fuel anomaly Day 1 follow-up',
      'Fuel anomaly Day 3 report due',
      'Critical fuel anomaly',
    ]);
    expect(anomaly.notifiedDay1At).toBeInstanceOf(Date);
    expect(anomaly.notifiedDay3At).toBeInstanceOf(Date);
    expect(anomaly.notifiedDay7At).toBeInstanceOf(Date);
  });
});
