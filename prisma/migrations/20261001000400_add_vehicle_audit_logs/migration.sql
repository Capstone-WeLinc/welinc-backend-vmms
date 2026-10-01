CREATE TABLE "vehicle_audit_logs" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" VARCHAR(100) NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "field_name" VARCHAR(50) NOT NULL,
    "previous_value" TEXT,
    "new_value" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vehicle_audit_logs_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "vehicle_audit_logs_vehicle_id_created_at_idx" ON "vehicle_audit_logs"("vehicle_id", "created_at");
CREATE INDEX "vehicle_audit_logs_user_id_created_at_idx" ON "vehicle_audit_logs"("user_id", "created_at");
