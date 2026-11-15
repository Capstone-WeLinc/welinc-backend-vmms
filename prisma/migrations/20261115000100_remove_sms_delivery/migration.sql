ALTER TABLE "maintenance_notifications"
  DROP COLUMN IF EXISTS "sms_status",
  DROP COLUMN IF EXISTS "sms_provider_id";
