CREATE TABLE "bms_fleet_change_events" (
    "event_id" UUID NOT NULL,
    "entity_type" VARCHAR(16) NOT NULL,
    "entity_id" UUID NOT NULL,
    "change_type" VARCHAR(32) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(80),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bms_fleet_change_events_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "bms_fleet_change_events_sent_at_next_attempt_at_idx"
    ON "bms_fleet_change_events"("sent_at", "next_attempt_at");
CREATE INDEX "bms_fleet_change_events_entity_type_entity_id_occurred_at_idx"
    ON "bms_fleet_change_events"("entity_type", "entity_id", "occurred_at");
