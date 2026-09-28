-- VR-MS-14 / AC-MS-11: historical records do not prevent new Pending work.
-- Current schedule identity is the truck plate (vehicleId) and template type (title).
-- Prisma cannot express this partial expression index; retain it in migrations.
-- If existing duplicates cause this migration to fail, resolve those schedules
-- through the application before retrying. Never delete or cancel history here.
CREATE UNIQUE INDEX "maintenance_schedules_pending_vehicle_type_key"
ON "maintenance_schedules" (LOWER(BTRIM("vehicleId")), LOWER(BTRIM("title")))
WHERE "status" = 'PENDING' AND "deleted_at" IS NULL;
