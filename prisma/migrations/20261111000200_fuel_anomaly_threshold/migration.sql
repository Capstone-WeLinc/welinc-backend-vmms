CREATE TABLE "fuel_anomaly_settings" (
  "id" VARCHAR(40) NOT NULL DEFAULT 'default',
  "threshold_percent" DECIMAL(5,2) NOT NULL DEFAULT 20,
  "updated_by_id" UUID,
  "updated_by_email" VARCHAR(255),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fuel_anomaly_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fuel_anomaly_settings_threshold_percent_check" CHECK ("threshold_percent" >= 1 AND "threshold_percent" <= 99)
);
INSERT INTO "fuel_anomaly_settings" ("id", "threshold_percent") VALUES ('default', 20);

CREATE TABLE "fuel_anomaly_threshold_audits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "actor_id" UUID NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "previous_threshold" DECIMAL(5,2),
  "new_threshold" DECIMAL(5,2) NOT NULL,
  "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fuel_anomaly_threshold_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fuel_anomaly_threshold_audits_new_threshold_check" CHECK ("new_threshold" >= 1 AND "new_threshold" <= 99)
);
CREATE INDEX "fuel_anomaly_threshold_audits_changed_at_idx" ON "fuel_anomaly_threshold_audits"("changed_at");
CREATE INDEX "fuel_anomaly_threshold_audits_actor_id_changed_at_idx" ON "fuel_anomaly_threshold_audits"("actor_id", "changed_at");
