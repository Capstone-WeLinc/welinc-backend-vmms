CREATE TYPE "MaintenanceApprovalStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED', 'FOR_REPAIR');
ALTER TABLE maintenance_schedules
  ADD COLUMN approval_status "MaintenanceApprovalStatus" NOT NULL DEFAULT 'UNVERIFIED';

UPDATE maintenance_schedules SET approval_status = (CASE
  WHEN status::text = 'COMPLETED' THEN 'VERIFIED'
  WHEN upper(replace(COALESCE(work_order_progress->>'approvalStatus', work_order_progress->>'workflowStatus'), ' ', '_')) = 'INCOMPLETE' THEN 'REJECTED'
  WHEN upper(replace(COALESCE(work_order_progress->>'approvalStatus', work_order_progress->>'workflowStatus'), ' ', '_')) IN ('VERIFIED', 'REJECTED', 'FOR_REPAIR')
    THEN upper(replace(COALESCE(work_order_progress->>'approvalStatus', work_order_progress->>'workflowStatus'), ' ', '_'))
  ELSE 'UNVERIFIED' END)::"MaintenanceApprovalStatus";

UPDATE maintenance_schedules SET work_order_progress =
  work_order_progress - 'workflowStatus' - 'approvalStatus' - 'mechanicSubmitted'
WHERE jsonb_typeof(work_order_progress) = 'object';
