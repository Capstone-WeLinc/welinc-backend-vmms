CREATE OR REPLACE FUNCTION vmms_protect_immutable_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_column text;
  name_column text;
  email_column text;
  key text;
  old_value jsonb;
  new_value jsonb;
  actor_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Append-only audit row cannot be deleted.';
  END IF;

  old_value := to_jsonb(OLD);
  new_value := to_jsonb(NEW);
  actor_column := TG_ARGV[0];
  name_column := CASE WHEN TG_NARGS > 1 THEN TG_ARGV[1] ELSE '' END;
  email_column := CASE WHEN TG_NARGS > 2 THEN TG_ARGV[2] ELSE '' END;
  actor_id := new_value ->> actor_column;

  IF old_value ->> actor_column IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'Append-only audit actor identity cannot change.';
  END IF;

  FOR key IN
    SELECT jsonb_object_keys(old_value)
  LOOP
    IF key <> name_column
       AND key <> email_column
       AND old_value -> key IS DISTINCT FROM new_value -> key THEN
      RAISE EXCEPTION 'Append-only audit field % cannot change.', key;
    END IF;
  END LOOP;

  IF name_column <> ''
     AND old_value ->> name_column IS DISTINCT FROM new_value ->> name_column
     AND new_value ->> name_column IS DISTINCT FROM 'Deleted user' THEN
    RAISE EXCEPTION 'Append-only audit name may only be redacted.';
  END IF;

  IF email_column <> ''
     AND old_value ->> email_column IS DISTINCT FROM new_value ->> email_column
     AND new_value ->> email_column IS DISTINCT FROM
       'deleted-' || actor_id || '@erased.invalid' THEN
    RAISE EXCEPTION 'Append-only audit email may only be redacted.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vmms_protect_append_only ON "audit_logs";
CREATE TRIGGER vmms_protect_append_only
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION vmms_protect_immutable_audit('user_id', '', 'email');

DROP TRIGGER IF EXISTS vmms_protect_append_only ON "shop_change_logs";
CREATE TRIGGER vmms_protect_append_only
BEFORE UPDATE OR DELETE ON "shop_change_logs"
FOR EACH ROW EXECUTE FUNCTION vmms_protect_immutable_audit('changed_by_user_id', 'changed_by_name', '');

DROP TRIGGER IF EXISTS vmms_protect_append_only ON "vehicle_audit_logs";
CREATE TRIGGER vmms_protect_append_only
BEFORE UPDATE OR DELETE ON "vehicle_audit_logs"
FOR EACH ROW EXECUTE FUNCTION vmms_protect_immutable_audit('user_id', '', 'email');

DROP TRIGGER IF EXISTS vmms_protect_append_only ON "fuel_audit_logs";
CREATE TRIGGER vmms_protect_append_only
BEFORE UPDATE OR DELETE ON "fuel_audit_logs"
FOR EACH ROW EXECUTE FUNCTION vmms_protect_immutable_audit('actor_id', '', 'actor_email');

DROP TRIGGER IF EXISTS vmms_protect_append_only ON "fuel_anomaly_threshold_audits";
CREATE TRIGGER vmms_protect_append_only
BEFORE UPDATE OR DELETE ON "fuel_anomaly_threshold_audits"
FOR EACH ROW EXECUTE FUNCTION vmms_protect_immutable_audit('actor_id', '', 'actor_email');

DROP TRIGGER IF EXISTS vmms_protect_append_only ON "maintenance_costing_threshold_audit";
CREATE TRIGGER vmms_protect_append_only
BEFORE UPDATE OR DELETE ON "maintenance_costing_threshold_audit"
FOR EACH ROW EXECUTE FUNCTION vmms_protect_immutable_audit('actor_id', '', 'actor_email');

DROP TRIGGER IF EXISTS vmms_protect_append_only ON "maintenance_log_edit_audits";
CREATE TRIGGER vmms_protect_append_only
BEFORE UPDATE OR DELETE ON "maintenance_log_edit_audits"
FOR EACH ROW EXECUTE FUNCTION vmms_protect_immutable_audit('actor_id', 'actor_name', 'actor_email');

ALTER TABLE "shop_change_logs"
  DROP CONSTRAINT "shop_change_logs_work_order_id_fkey",
  ADD CONSTRAINT "shop_change_logs_work_order_id_fkey"
    FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_logs"
  DROP CONSTRAINT "audit_logs_work_order_id_fkey",
  ADD CONSTRAINT "audit_logs_work_order_id_fkey"
    FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vehicle_audit_logs"
  DROP CONSTRAINT "vehicle_audit_logs_vehicle_id_fkey",
  ADD CONSTRAINT "vehicle_audit_logs_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
