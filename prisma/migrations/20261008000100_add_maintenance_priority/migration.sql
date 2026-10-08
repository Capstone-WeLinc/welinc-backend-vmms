CREATE TYPE "MaintenancePriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

ALTER TABLE "maintenance_schedules"
ADD COLUMN "priority" "MaintenancePriority" NOT NULL DEFAULT 'MEDIUM';
