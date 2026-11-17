import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MaintenanceSchedule, MaintenanceStatus } from '@prisma/client';
import { ScheduleActor } from './schedule-access';
import { getWorkOrderStartDateError } from './work-order-start-date';
import { progressForClient } from './work-order-state';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export type AssignedChecklistItem = { id: string; text: string };

function validateChecklistSubmission(
  items: unknown,
  assignedItems?: AssignedChecklistItem[],
) {
  const entries: unknown[] = Array.isArray(items) ? items : [];
  const required =
    assignedItems ??
    entries.map((item, index) => {
      const entry = isRecord(item) ? item : {};
      return {
        id: typeof entry.id === 'string' ? entry.id : '',
        text:
          typeof entry.label === 'string' && entry.label
            ? entry.label
            : `Checklist item ${index + 1}`,
      };
    });
  if (!required.length) {
    throw new BadRequestException(
      'No checklist items are assigned. Ask Operations to assign a checklist before submitting.',
    );
  }
  const incompleteItems = required
    .filter((requiredItem) => {
      const matches = entries.filter(
        (item) => isRecord(item) && item.id === requiredItem.id,
      );
      return (
        matches.length !== 1 ||
        !isRecord(matches[0]) ||
        !['checked', 'changed'].includes(String(matches[0].status))
      );
    })
    .map((item) => ({ id: item.id, label: item.text }));
  if (incompleteItems.length) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'INCOMPLETE_CHECKLIST',
      message: `Complete every assigned checklist item before submitting:\n${incompleteItems.map((item) => `- ${item.label}`).join('\n')}`,
      incompleteItems,
    });
  }
  if (
    !Array.isArray(items) ||
    entries.length !== required.length ||
    entries.some(
      (item) =>
        !isRecord(item) ||
        typeof item.id !== 'string' ||
        !item.id.trim() ||
        !required.some((requiredItem) => requiredItem.id === item.id),
    ) ||
    new Set(
      entries.map((item) =>
        isRecord(item) && typeof item.id === 'string' ? item.id : null,
      ),
    ).size !== entries.length
  ) {
    throw new BadRequestException(
      'Checklist items do not match the assigned checklist. Refresh the work order and try again.',
    );
  }
}

export function applyWorkOrderWorkflow(
  schedule: MaintenanceSchedule,
  incoming: UnknownRecord,
  action: unknown,
  actor: ScheduleActor,
  assignedItems?: AssignedChecklistItem[],
) {
  const prior = progressForClient(schedule);
  const chief =
    actor.roles.some(
      (r) => r.system === 'VMMS' && r.role === 'CHIEF_MECHANIC',
    ) && schedule.chiefMechanicId === actor.sub;
  const mechanic =
    actor.roles.some((r) => r.system === 'VMMS' && r.role === 'MECHANIC') &&
    schedule.assignedMechanicId === actor.sub;
  if (!chief && !mechanic)
    throw new ForbiddenException(
      'Only the assigned mechanic or chief mechanic may progress this work order.',
    );
  if (['COMPLETED', 'CANCELLED'].includes(schedule.status))
    throw new BadRequestException('This work order is closed.');
  const progress: UnknownRecord = { ...prior };
  const overdueInProgress =
    schedule.status === MaintenanceStatus.OVERDUE &&
    progress.overdueFromStatus === 'IN_PROGRESS';
  let status = schedule.status;
  const intent = action ?? 'SAVE';
  if (
    !['SAVE', 'START', 'SUBMIT', 'APPROVE', 'REJECT', 'REPAIR'].includes(
      intent as string,
    )
  )
    throw new BadRequestException('Invalid workflow action.');
  if (chief) {
    if (!prior.mechanicSubmitted)
      throw new BadRequestException(
        'The mechanic must submit the work before review.',
      );
    if (['START', 'SUBMIT'].includes(intent as string))
      throw new ForbiddenException(
        'Only the assigned mechanic can execute the work.',
      );
    for (const key of ['inspectionItems', 'inspectorRemarks'])
      if (incoming[key] !== undefined) progress[key] = incoming[key];
    if (
      incoming.inspectorRemarks !== undefined &&
      typeof incoming.inspectorRemarks !== 'string'
    )
      throw new BadRequestException('Inspection remarks must be text.');
    const items = records(progress.inspectionItems);
    if (intent !== 'SAVE') {
      const execution = records(prior.executionItems);
      if (
        !items.length ||
        !items.every(
          (item) =>
            typeof item.status === 'string' &&
            ['pass', 'fail'].includes(item.status),
        ) ||
        execution.length !== items.length ||
        new Set(items.map((item) => item.id)).size !== items.length ||
        !execution.every((item) =>
          items.some((inspection) => inspection.id === item.id),
        )
      ) {
        throw new BadRequestException(
          'Complete the inspection for every execution checklist item.',
        );
      }
      if (intent === 'APPROVE' && items.some((item) => item.status !== 'pass'))
        throw new BadRequestException(
          'Every inspection item must pass before completion.',
        );
      progress.approvalStatus =
        intent === 'APPROVE'
          ? 'Verified'
          : intent === 'REJECT'
            ? 'Rejected'
            : 'For Repair';
      progress.workflowStatus =
        intent === 'APPROVE'
          ? 'Completed'
          : intent === 'REJECT'
            ? 'Rejected'
            : 'For Repair';
      if (intent === 'REJECT') {
        const rejectionRemarks =
          typeof progress.inspectorRemarks === 'string'
            ? progress.inspectorRemarks.trim()
            : '';
        if (!rejectionRemarks)
          throw new BadRequestException(
            'Add rejection remarks before returning this work order to the mechanic.',
          );
        progress.rejectionRemarks = rejectionRemarks;
      }
      progress.mechanicSubmitted = intent !== 'REJECT';
      status =
        intent === 'APPROVE'
          ? MaintenanceStatus.COMPLETED
          : MaintenanceStatus.IN_PROGRESS;
    }
  } else {
    if (
      ['APPROVE', 'REJECT', 'REPAIR'].includes(intent as string) ||
      incoming.workflowStatus === 'Completed' ||
      incoming.approvalStatus === 'Verified'
    )
      throw new ForbiddenException(
        'Only the assigned chief mechanic can approve completion.',
      );
    if (prior.mechanicSubmitted)
      throw new BadRequestException('Work is awaiting chief mechanic review.');
    if (intent === 'START') {
      const startDateError = getWorkOrderStartDateError(schedule.startDate);
      if (startDateError) throw new BadRequestException(startDateError);
      if (
        !['PENDING', 'DUE', 'OVERDUE'].includes(schedule.status) &&
        prior.workflowStatus !== 'Rejected'
      )
        throw new BadRequestException('This work order has already started.');
      status = MaintenanceStatus.IN_PROGRESS;
      delete progress.overdueFromStatus;
      progress.workflowStatus = 'In Progress';
      progress.approvalStatus = 'Unverified';
      progress.mechanicSubmitted = false;
      progress.inspectionItems = [];
      if (
        prior.workflowStatus === 'Rejected' &&
        !progress.rejectionRemarks &&
        typeof prior.inspectorRemarks === 'string'
      )
        progress.rejectionRemarks = prior.inspectorRemarks;
      progress.inspectorRemarks = '';
    } else {
      if (
        (status !== MaintenanceStatus.IN_PROGRESS && !overdueInProgress) ||
        prior.workflowStatus === 'Rejected'
      )
        throw new BadRequestException(
          'Start work before updating the checklist.',
        );
      for (const key of [
        'executionItems',
        'partDetails',
        'chiefMechanic',
        'maintenanceClass',
        'laborCost',
        'serviceOdometerReading',
      ])
        if (incoming[key] !== undefined) progress[key] = incoming[key];
      if (incoming.maintenanceRemarks !== undefined) {
        if (typeof incoming.maintenanceRemarks !== 'string')
          throw new BadRequestException('Maintenance remarks must be text.');
        progress.maintenanceRemarks = incoming.maintenanceRemarks;
      }
      if (intent === 'SUBMIT') {
        const items = records(progress.executionItems);
        validateChecklistSubmission(items, assignedItems);
        for (const item of items.filter((item) => item.status === 'changed')) {
          const itemId = typeof item.id === 'string' ? item.id : '';
          const partDetails = isRecord(progress.partDetails)
            ? progress.partDetails
            : {};
          const rawPart = partDetails[itemId];
          const part = isRecord(rawPart) ? rawPart : {};
          const attachments = Array.isArray(part.attachments)
            ? part.attachments
            : [];
          const materialCost = part.materialCost;
          const cost =
            typeof materialCost === 'number'
              ? materialCost
              : typeof materialCost === 'string' && materialCost.trim()
                ? Number(materialCost)
                : Number.NaN;
          if (
            typeof part.partsUsed !== 'string' ||
            !part.partsUsed.trim() ||
            !Number.isFinite(Number(part.quantity)) ||
            Number(part.quantity) <= 0 ||
            !Number.isFinite(cost) ||
            cost < 0 ||
            !attachments.length
          )
            throw new BadRequestException(
              'Provide parts, quantity, cost and photos for each changed item.',
            );
        }
        progress.workflowStatus = 'Done';
        progress.approvalStatus = 'Unverified';
        progress.mechanicSubmitted = true;
        progress.inspectionItems = items.map((item) => ({
          id: item.id,
          label: item.label,
          status: 'pending',
          note: '',
        }));
        status = MaintenanceStatus.DONE;
        delete progress.overdueFromStatus;
      }
    }
  }
  return { status, progress };
}
