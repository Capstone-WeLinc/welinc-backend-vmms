import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MaintenanceSchedule, MaintenanceStatus } from '@prisma/client';
import { ScheduleActor } from './schedule-access';

export function applyWorkOrderWorkflow(schedule: MaintenanceSchedule, incoming: Record<string, any>, action: unknown, actor: ScheduleActor) {
  const prior = (schedule.workOrderProgress && typeof schedule.workOrderProgress === 'object' && !Array.isArray(schedule.workOrderProgress) ? schedule.workOrderProgress : {}) as Record<string, any>;
  const chief = actor.roles.some((r) => r.system === 'VMMS' && r.role === 'CHIEF_MECHANIC') && schedule.chiefMechanicId === actor.sub;
  const mechanic = actor.roles.some((r) => r.system === 'VMMS' && r.role === 'MECHANIC') && schedule.assignedMechanicId === actor.sub;
  if (!chief && !mechanic) throw new ForbiddenException('Only the assigned mechanic or chief mechanic may progress this work order.');
  if (['COMPLETED', 'CANCELLED'].includes(schedule.status)) throw new BadRequestException('This work order is closed.');
  const progress = { ...prior };
  let status = schedule.status;
  const intent = action ?? 'SAVE';
  if (!['SAVE', 'START', 'SUBMIT', 'APPROVE', 'REJECT', 'REPAIR'].includes(intent as string)) throw new BadRequestException('Invalid workflow action.');
  if (chief) {
    if (!prior.mechanicSubmitted) throw new BadRequestException('The mechanic must submit the work before review.');
    if (['START', 'SUBMIT'].includes(intent as string)) throw new ForbiddenException('Only the assigned mechanic can execute the work.');
    for (const key of ['inspectionItems', 'inspectorRemarks']) if (incoming[key] !== undefined) progress[key] = incoming[key];
    const items = progress.inspectionItems;
    if (intent !== 'SAVE') {
      const execution = prior.executionItems;
      if (!Array.isArray(items) || !items.length || !items.every((item) => ['pass', 'fail'].includes(item?.status)) ||
          !Array.isArray(execution) || execution.length !== items.length || new Set(items.map((item) => item.id)).size !== items.length ||
          !execution.every((item) => items.some((inspection) => inspection.id === item.id))) {
        throw new BadRequestException('Complete the inspection for every execution checklist item.');
      }
      if (intent === 'APPROVE' && items.some((item) => item.status !== 'pass')) throw new BadRequestException('Every inspection item must pass before completion.');
      progress.approvalStatus = intent === 'APPROVE' ? 'Verified' : intent === 'REJECT' ? 'Rejected' : 'For Repair';
      progress.workflowStatus = intent === 'APPROVE' ? 'Completed' : intent === 'REJECT' ? 'Rejected' : 'For Repair';
      progress.mechanicSubmitted = intent !== 'REJECT';
      status = intent === 'APPROVE' ? MaintenanceStatus.COMPLETED : MaintenanceStatus.IN_PROGRESS;
    }
  } else {
    if (['APPROVE', 'REJECT', 'REPAIR'].includes(intent as string) || incoming.workflowStatus === 'Completed' || incoming.approvalStatus === 'Verified') throw new ForbiddenException('Only the assigned chief mechanic can approve completion.');
    if (prior.mechanicSubmitted) throw new BadRequestException('Work is awaiting chief mechanic review.');
    if (intent === 'START') {
      if (!['PENDING', 'DUE', 'OVERDUE'].includes(schedule.status) && prior.workflowStatus !== 'Rejected') throw new BadRequestException('This work order has already started.');
      status = MaintenanceStatus.IN_PROGRESS;
      progress.workflowStatus = 'In Progress';
      progress.approvalStatus = 'Unverified';
      progress.mechanicSubmitted = false;
      progress.inspectionItems = [];
      progress.inspectorRemarks = '';
    } else {
      if (status !== MaintenanceStatus.IN_PROGRESS || prior.workflowStatus === 'Rejected') throw new BadRequestException('Start work before updating the checklist.');
      for (const key of ['executionItems', 'partDetails', 'chiefMechanic']) if (incoming[key] !== undefined) progress[key] = incoming[key];
      if (intent === 'SUBMIT') {
        const items = progress.executionItems;
        if (!Array.isArray(items) || !items.length || !items.every((item) => item?.id && ['checked', 'changed', 'notChecked'].includes(item.status)) || new Set(items.map((item) => item.id)).size !== items.length) throw new BadRequestException('Complete every execution checklist item before submitting.');
        for (const item of items.filter((item) => item.status === 'changed')) {
          const part = progress.partDetails?.[item.id];
          if (!part?.partsUsed?.trim() || !Number.isFinite(Number(part.quantity)) || Number(part.quantity) <= 0 || String(part.materialCost ?? '').trim() === '' || !Number.isFinite(Number(part.materialCost)) || Number(part.materialCost) < 0 || !Array.isArray(part.attachments) || !part.attachments.length) throw new BadRequestException('Provide parts, quantity, cost and photos for each changed item.');
        }
        progress.workflowStatus = 'Done';
        progress.approvalStatus = 'Unverified';
        progress.mechanicSubmitted = true;
        progress.inspectionItems = items.map((item) => ({ id: item.id, label: item.label, status: 'pending', note: '' }));
        status = MaintenanceStatus.DONE;
      }
    }
  }
  return { status, progress };
}
