CREATE TABLE "maintenance_costing_settings" (
    "id" VARCHAR(40) NOT NULL DEFAULT 'default',
    "threshold" DECIMAL(12,2),
    "updated_by_id" UUID,
    "updated_by_email" VARCHAR(255),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_costing_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "maintenance_costing_settings_threshold_positive_check"
        CHECK ("threshold" IS NULL OR "threshold" > 0)
);

CREATE TABLE "maintenance_costing_threshold_audit" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "actor_email" VARCHAR(255) NOT NULL,
    "previous_threshold" DECIMAL(12,2),
    "new_threshold" DECIMAL(12,2) NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_costing_threshold_audit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "maintenance_costing_threshold_audit_new_threshold_positive_check"
        CHECK ("new_threshold" > 0)
);

CREATE INDEX "maintenance_costing_threshold_audit_changed_at_idx"
    ON "maintenance_costing_threshold_audit"("changed_at");

CREATE INDEX "maintenance_costing_threshold_audit_actor_id_changed_at_idx"
    ON "maintenance_costing_threshold_audit"("actor_id", "changed_at");
