import { BadRequestException } from '@nestjs/common';
import { MaintenanceSchedule, MaintenanceStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { applyWorkOrderWorkflow } from './work-order-workflow';

const actor = {
  sub: 'mechanic-1',
  system: 'VMMS',
  roles: [{ role: 'MECHANIC', system: 'VMMS' }],
};
const assigned = [
  { id: 'oil', text: 'Inspect oil' },
  { id: 'brakes', text: 'Inspect brakes' },
];
const checked = assigned.map((item) => ({
  id: item.id,
  label: item.text,
  status: 'checked',
}));
const schedule = {
  id: 'schedule-1',
  vehicleId: 'ABC123',
  status: MaintenanceStatus.IN_PROGRESS,
  assignedMechanicId: actor.sub,
  assignedMechanic: 'Mechanic One',
  odometerReading: 1200,
  checklistTemplateId: 'template-1',
  updatedAt: new Date(),
  workOrderProgress: {},
} as MaintenanceSchedule;

function rejection(items: unknown, required = assigned): Record<string, any> {
  try {
    applyWorkOrderWorkflow(
      schedule,
      { executionItems: items },
      'SUBMIT',
      actor,
      required,
    );
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse();
    expect(typeof response).toBe('object');
    return response as Record<string, any>;
  }
  throw new Error('Expected submission to be rejected');
}

describe('checklist completion requirement', () => {
  it.each(['notChecked', 'pending', 'unknown', undefined])(
    'rejects %s and identifies the assigned item',
    (status) => {
      const error = rejection([
        checked[0],
        { id: 'brakes', label: 'Spoofed label', status },
      ]);
      expect(error.code).toBe('INCOMPLETE_CHECKLIST');
      expect(error.incompleteItems).toEqual([
        { id: 'brakes', label: 'Inspect brakes' },
      ]);
      expect(error.message).toContain('Inspect brakes');
      expect(error.message).not.toContain('Spoofed label');
    },
  );

  it('lists missing and unfinished items together', () => {
    expect(
      rejection([{ id: 'oil', status: 'notChecked' }]).incompleteItems,
    ).toEqual([
      { id: 'oil', label: 'Inspect oil' },
      { id: 'brakes', label: 'Inspect brakes' },
    ]);
  });

  it.each([undefined, null, [], {}, [null]])(
    'rejects malformed or empty execution data: %p',
    (items) => {
      expect(rejection(items).incompleteItems).toHaveLength(2);
    },
  );

  it('rejects substituted and duplicate IDs', () => {
    expect(
      rejection([checked[0], { id: 'fake', status: 'checked' }])
        .incompleteItems,
    ).toEqual([{ id: 'brakes', label: 'Inspect brakes' }]);
    expect(
      rejection([checked[0], checked[0], checked[1]]).incompleteItems,
    ).toEqual([{ id: 'oil', label: 'Inspect oil' }]);
  });

  it('rejects additional unassigned items even when required items are complete', () => {
    expect(
      rejection([...checked, { id: 'fake', status: 'checked' }]).message,
    ).toMatch(/do not match/);
  });

  it('rejects an empty assigned checklist', () => {
    expect(rejection(checked, []).message).toMatch(
      /No checklist items are assigned/,
    );
  });

  it('moves fully checked work to Done for inspection', () => {
    const result = applyWorkOrderWorkflow(
      schedule,
      { executionItems: checked },
      'SUBMIT',
      actor,
      assigned,
    );
    expect(result.status).toBe(MaintenanceStatus.DONE);
    expect(result.progress.mechanicSubmitted).toBe(true);
    expect(result.progress.inspectionItems).toHaveLength(2);
    expect(schedule.status).toBe(MaintenanceStatus.IN_PROGRESS);
  });

  it('allows a mechanic to continue saving in-progress work after the daily overdue transition', () => {
    const overdueSchedule = {
      ...schedule,
      status: MaintenanceStatus.OVERDUE,
      workOrderProgress: {
        executionItems: checked,
        overdueFromStatus: MaintenanceStatus.IN_PROGRESS,
      },
    } as MaintenanceSchedule;
    const result = applyWorkOrderWorkflow(
      overdueSchedule,
      { executionItems: checked },
      'SAVE',
      actor,
    );
    expect(result.status).toBe(MaintenanceStatus.OVERDUE);
    expect(result.progress.overdueFromStatus).toBe(
      MaintenanceStatus.IN_PROGRESS,
    );
  });

  it('still requires parts details for Changed items', () => {
    const executionItems = [checked[0], { ...checked[1], status: 'changed' }];
    expect(rejection(executionItems).message).toMatch(
      /parts, quantity, cost and photos/,
    );
    const result = applyWorkOrderWorkflow(
      schedule,
      {
        executionItems,
        partDetails: {
          brakes: {
            partsUsed: 'Brake pads',
            quantity: 1,
            materialCost: 500,
            attachments: [{ name: 'photo.jpg' }],
          },
        },
      },
      'SUBMIT',
      actor,
      assigned,
    );
    expect(result.status).toBe(MaintenanceStatus.DONE);
  });

  it('allows incomplete drafts to be saved without marking them Done', () => {
    const result = applyWorkOrderWorkflow(
      schedule,
      {
        executionItems: [{ id: 'oil', status: 'notChecked' }],
      },
      'SAVE',
      actor,
    );
    expect(result.status).toBe(MaintenanceStatus.IN_PROGRESS);
    expect(result.progress.mechanicSubmitted).not.toBe(true);
  });
});

describe('submission through MaintenanceSchedulesService', () => {
  let service: MaintenanceSchedulesService;
  const prisma = {
    maintenanceSchedule: { findFirst: jest.fn(), update: jest.fn() },
    checklistItem: { findMany: jest.fn() },
    vehicle: { findFirst: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ ...schedule });
    prisma.maintenanceSchedule.update.mockImplementation(async ({ data }) => ({
      ...schedule,
      ...data,
    }));
    prisma.checklistItem.findMany.mockResolvedValue(assigned);
    prisma.vehicle.findFirst.mockResolvedValue({
      id: 'vehicle-1',
      status: 'UNDER_MAINTENANCE',
    });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([{ logNumber: 'MLG-20261109-0001' }]);
    service = new MaintenanceSchedulesService(
      prisma as unknown as PrismaService,
    );
  });

  it('checks the server checklist and never writes incomplete submissions', async () => {
    await expect(
      service.updateProgress(
        schedule.id,
        {
          action: 'SUBMIT',
          executionItems: [checked[0]],
        },
        actor,
      ),
    ).rejects.toThrow('Inspect brakes');
    expect(prisma.checklistItem.findMany).toHaveBeenCalledWith({
      where: { checklistTemplateId: 'template-1', deletedAt: null },
      select: { id: true, text: true },
      orderBy: { order: 'asc' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('cannot bypass validation by omitting items and using saved incomplete progress', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({
      ...schedule,
      workOrderProgress: {
        executionItems: [{ id: 'oil', status: 'notChecked' }],
      },
    });
    await expect(
      service.updateProgress(schedule.id, { action: 'SUBMIT' }, actor),
    ).rejects.toThrow('Inspect oil');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a work order without an assigned template', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({
      ...schedule,
      checklistTemplateId: null,
    });
    await expect(
      service.updateProgress(
        schedule.id,
        { action: 'SUBMIT', executionItems: checked },
        actor,
      ),
    ).rejects.toThrow('No checklist is assigned');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('persists Done only after every assigned item is complete', async () => {
    const result = await service.updateProgress(
      schedule.id,
      {
        action: 'SUBMIT',
        executionItems: checked,
        maintenanceClass: 'PREVENTIVE',
        maintenanceRemarks: 'Completed oil and brake checks.',
        serviceOdometerReading: 12345,
        laborCost: 300,
        totalCost: 1,
        partDetails: {
          oil: { partsUsed: 'Oil filter', quantity: 2, materialCost: 125 },
        },
      },
      actor,
    );
    expect(result.status).toBe(MaintenanceStatus.DONE);
    expect(prisma.maintenanceSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: schedule.id,
          updatedAt: schedule.updatedAt,
        }),
        data: expect.objectContaining({ status: MaintenanceStatus.DONE }),
      }),
    );
    expect(prisma.maintenanceSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ logNumber: 'MLG-20261109-0001' }),
      }),
    );
    expect(prisma.maintenanceSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          odometerReading: 12345,
          partsCost: 125,
          laborCost: 300,
          totalCost: 425,
        }),
      }),
    );
    expect(result.logNumber).toBe('MLG-20261109-0001');
  });

  it('does not generate a second log number when a rejected work order is resubmitted', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({
      ...schedule,
      logNumber: 'MLG-20261101-0012',
    });
    prisma.maintenanceSchedule.update.mockImplementation(async ({ data }) => ({
      ...schedule,
      ...data,
      logNumber: 'MLG-20261101-0012',
    }));
    const result = await service.updateProgress(
      schedule.id,
      {
        action: 'SUBMIT',
        executionItems: checked,
        maintenanceClass: 'REPAIR',
        maintenanceRemarks: 'Replaced brake components.',
        serviceOdometerReading: 12345,
        laborCost: 500,
      },
      actor,
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(prisma.maintenanceSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ logNumber: expect.anything() }),
      }),
    );
    expect(result.logNumber).toBe('MLG-20261101-0012');
  });

  it.each([
    [
      'odometer',
      { serviceOdometerReading: undefined },
      'Enter a valid odometer reading',
    ],
    [
      'maintenance type',
      { maintenanceClass: undefined },
      'Select Repair or Preventive',
    ],
    [
      'description',
      { maintenanceRemarks: '  ' },
      'Describe the work performed',
    ],
    ['labor cost', { laborCost: undefined }, 'Enter a valid labor cost'],
  ])(
    'rejects a missing or invalid %s before writing',
    async (_field, override, expected) => {
      await expect(
        service.updateProgress(
          schedule.id,
          {
            action: 'SUBMIT',
            executionItems: checked,
            maintenanceClass: 'PREVENTIVE',
            maintenanceRemarks: 'Work done',
            serviceOdometerReading: 12345,
            laborCost: 100,
            ...override,
          },
          actor,
        ),
      ).rejects.toThrow(expected);
      expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
    },
  );
});
