CREATE TABLE "login_activities" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "email" VARCHAR(255) NOT NULL,
    "event" VARCHAR(30) NOT NULL,
    "ip_address" VARCHAR(45),
    "device_type" VARCHAR(30) NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_activities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "login_activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "login_activities_user_id_created_at_idx" ON "login_activities"("user_id", "created_at");
