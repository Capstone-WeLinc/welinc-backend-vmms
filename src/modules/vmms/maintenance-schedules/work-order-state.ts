import { MaintenanceApprovalStatus, MaintenanceStatus, Prisma } from '@prisma/client';

const stageLabels: Record<MaintenanceStatus, string> = {
  PENDING: 'Pending', DUE: 'Pending', IN_PROGRESS: 'In Progress', DONE: 'Done',
  COMPLETED: 'Completed', OVERDUE: 'Overdue', CANCELLED: 'Cancelled',
};
const decisionLabels: Record<MaintenanceApprovalStatus, string> = {
  UNVERIFIED: 'Unverified', VERIFIED: 'Verified', REJECTED: 'Rejected', FOR_REPAIR: 'For Repair',
};
const key = (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '_') : '';

export function approvalEnum(value: unknown, status: unknown): MaintenanceApprovalStatus {
  if (status === MaintenanceStatus.COMPLETED) return MaintenanceApprovalStatus.VERIFIED;
  const normalized = key(value);
  if (normalized === 'INCOMPLETE') return MaintenanceApprovalStatus.REJECTED;
  return Object.values(MaintenanceApprovalStatus).includes(normalized as MaintenanceApprovalStatus)
    ? normalized as MaintenanceApprovalStatus : MaintenanceApprovalStatus.UNVERIFIED;
}

// Compatibility labels only. The database stores the stage and decision in enum columns.
export function progressForClient(schedule: {
  status: unknown; approvalStatus?: unknown; workOrderProgress?: unknown;
}): Record<string, any> {
  const raw = schedule.workOrderProgress;
  const progress = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } as Record<string, any> : {};
  const decision = approvalEnum(schedule.approvalStatus ?? progress.approvalStatus ?? progress.workflowStatus, schedule.status);
  const returned = schedule.status === MaintenanceStatus.IN_PROGRESS &&
    (decision === MaintenanceApprovalStatus.REJECTED || decision === MaintenanceApprovalStatus.FOR_REPAIR);
  return {
    ...progress,
    workflowStatus: returned ? decisionLabels[decision] : stageLabels[schedule.status as MaintenanceStatus] ?? 'Pending',
    approvalStatus: decisionLabels[decision],
    mechanicSubmitted: schedule.approvalStatus !== undefined
      ? schedule.status === MaintenanceStatus.DONE || schedule.status === MaintenanceStatus.COMPLETED ||
        (schedule.status === MaintenanceStatus.IN_PROGRESS && decision === MaintenanceApprovalStatus.FOR_REPAIR)
      : progress.mechanicSubmitted === true,
  };
}

export function stateForStorage(progress: Record<string, any>, status: unknown) {
  const { workflowStatus, approvalStatus, mechanicSubmitted, ...details } = progress;
  return {
    approvalStatus: approvalEnum(approvalStatus ?? workflowStatus, status),
    workOrderProgress: details as Prisma.InputJsonObject,
  };
}
