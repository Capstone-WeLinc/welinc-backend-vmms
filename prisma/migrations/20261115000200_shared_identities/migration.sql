DO $$
DECLARE fk RECORD;
BEGIN
  FOR fk IN
    SELECT conrelid::regclass AS table_name, conname
      FROM pg_constraint
     WHERE contype = 'f'
       AND confrelid = 'users'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
  END LOOP;
END $$;

DROP TABLE IF EXISTS "password_reset_tokens";
DROP TABLE IF EXISTS "refresh_tokens";
DROP TABLE IF EXISTS "login_activities";
DROP TABLE IF EXISTS "user_roles";
DROP TABLE IF EXISTS "users";

ALTER TABLE "mechanics"
  ADD COLUMN IF NOT EXISTS "email" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "role" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "temporary_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS "directory_sync_state" (
  "id" TEXT NOT NULL,
  "cursor" TEXT,
  "lease_until" TIMESTAMPTZ(3),
  "lease_owner" UUID,
  "failing_since" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "directory_sync_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "directory_sync_state_id_check" CHECK ("id" = 'auth')
);

CREATE TABLE IF NOT EXISTS "vmms_people" (
  "auth_user_id" UUID NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "picture" TEXT,
  "roles" TEXT[] NOT NULL,
  "temporary_roles" TEXT[] NOT NULL,
  "is_active" BOOLEAN NOT NULL,
  "deleted" BOOLEAN NOT NULL,
  "erased" BOOLEAN NOT NULL DEFAULT FALSE,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vmms_people_pkey" PRIMARY KEY ("auth_user_id")
);
