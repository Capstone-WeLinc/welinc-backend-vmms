import { BadRequestException } from '@nestjs/common';
import { MaintenanceSchedule, MaintenanceStatus } from '@prisma/client';
import { applyWorkOrderWorkflow } from './work-order-workflow';

const mechanic = {
  sub: 'mechanic-1',
  system: 'VMMS',
  roles: [{ role: 'MECHANIC', system: 'VMMS' }],
};

describe('work order start date enforcement', () => {
  const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const schedule = {
    id: 'schedule-1',
    vehicleId: 'TRUCK-1',
    assignedMechanicId: mechanic.sub,
    status: MaintenanceStatus.PENDING,
    startDate: tomorrow,
    workOrderProgress: {},
  } as MaintenanceSchedule;

  it('rejects START before the scheduled start date', () => {
    expect(() =>
      applyWorkOrderWorkflow(schedule, {}, 'START', mechanic),
    ).toThrow(BadRequestException);
  });

  it('rejects START when the schedule has no start date', () => {
    expect(() =>
      applyWorkOrderWorkflow(
        { ...schedule, startDate: null },
        {},
        'START',
        mechanic,
      ),
    ).toThrow(/no scheduled start date/i);
  });
});
