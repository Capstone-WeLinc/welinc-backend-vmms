-- Time-triggered sample rows already derive their calendar due date from the
-- interval/reference pair in scheduleDue(). Keep that authoritative calculation
-- instead of replacing it with the generic sample fallback from migration 005.
UPDATE "maintenance_schedules"
SET "target_due_date" = NULL
WHERE "trigger_type" = 'TIME';
