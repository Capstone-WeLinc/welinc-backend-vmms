import { applyWorkOrderWorkflow } from './work-order-workflow';
import { stateForStorage } from './work-order-state';

describe('Maintenance remarks lifecycle', () => {
  const mechanic = {
    sub: 'mechanic',
    roles: [{ system: 'VMMS', role: 'MECHANIC' }],
  };
  const chief = {
    sub: 'chief',
    roles: [{ system: 'VMMS', role: 'CHIEF_MECHANIC' }],
  };
  const initial = () =>
    ({
      status: 'IN_PROGRESS',
      assignedMechanicId: 'mechanic',
      chiefMechanicId: 'chief',
      startDate: new Date('2020-01-01'),
      workOrderProgress: {
        executionItems: [{ id: 'oil', label: 'Oil', status: 'checked' }],
      },
    }) as any;
  const run = (schedule: any, input: any, action: string, actor = mechanic) => {
    const result = applyWorkOrderWorkflow(schedule, input, action, actor);
    // Simulate storage and reload, rather than retaining the in-memory object.
    const stored = stateForStorage(result.progress, result.status);
    expect(stored.workOrderProgress).not.toHaveProperty('workflowStatus');
    expect(stored.workOrderProgress).not.toHaveProperty('approvalStatus');
    return {
      ...schedule,
      status: result.status,
      ...JSON.parse(JSON.stringify(stored)),
    };
  };

  it('retains the mechanic description through save, reject, restart, resubmit and approval', () => {
    let schedule = run(
      initial(),
      { maintenanceRemarks: 'Changed oil.\nChecked for leaks.' },
      'SAVE',
    );
    expect(schedule.workOrderProgress.maintenanceRemarks).toBe(
      'Changed oil.\nChecked for leaks.',
    );
    schedule = run(schedule, {}, 'SUBMIT');
    schedule = run(
      schedule,
      {
        inspectorRemarks: 'Clean spilled oil.',
        inspectionItems: [{ id: 'oil', status: 'fail' }],
      },
      'REJECT',
      chief,
    );
    expect(schedule.status).toBe('IN_PROGRESS');
    expect(schedule.workOrderProgress.rejectionRemarks).toBe(
      'Clean spilled oil.',
    );
    schedule = run(schedule, {}, 'START');
    expect(schedule.workOrderProgress.rejectionRemarks).toBe(
      'Clean spilled oil.',
    );
    expect(schedule.workOrderProgress.maintenanceRemarks).toBe(
      'Changed oil.\nChecked for leaks.',
    );
    schedule = run(
      schedule,
      { maintenanceRemarks: 'Changed oil and cleaned spills.' },
      'SUBMIT',
    );
    schedule = run(
      schedule,
      {
        inspectorRemarks: 'Verified.',
        inspectionItems: [{ id: 'oil', status: 'pass' }],
        maintenanceRemarks: 'Unauthorized replacement',
      },
      'APPROVE',
      chief,
    );
    expect(schedule.status).toBe('COMPLETED');
    expect(schedule.workOrderProgress.maintenanceRemarks).toBe(
      'Changed oil and cleaned spills.',
    );
    expect(schedule.workOrderProgress.inspectorRemarks).toBe('Verified.');
  });

  it('does not allow the mechanic to overwrite rejection feedback', () => {
    const schedule = initial();
    schedule.workOrderProgress.rejectionRemarks = 'Check the seal.';
    expect(
      run(
        schedule,
        { rejectionRemarks: 'Forged', inspectorRemarks: 'Forged' },
        'SAVE',
      ).workOrderProgress.rejectionRemarks,
    ).toBe('Check the seal.');
  });

  it('preserves rejection feedback from older records on restart', () => {
    const schedule = initial();
    schedule.workOrderProgress = {
      workflowStatus: 'Rejected',
      inspectorRemarks: 'Retighten.',
    };
    expect(run(schedule, {}, 'START').workOrderProgress.rejectionRemarks).toBe(
      'Retighten.',
    );
  });

  it('allows clearing a draft remark and rejects non-text remarks', () => {
    expect(
      run(initial(), { maintenanceRemarks: '' }, 'SAVE').workOrderProgress
        .maintenanceRemarks,
    ).toBe('');
    expect(() => run(initial(), { maintenanceRemarks: {} }, 'SAVE')).toThrow(
      'Maintenance remarks must be text',
    );
  });

  it('locks maintenance remarks after submission', () => {
    const schedule = run(
      initial(),
      { maintenanceRemarks: 'Serviced.' },
      'SUBMIT',
    );
    expect(() =>
      run(schedule, { maintenanceRemarks: 'Altered' }, 'SAVE'),
    ).toThrow('awaiting chief mechanic review');
  });
});
