// Run: node test/pending-schedule-index.integration.cjs
// Uses DATABASE_URL, but all writes are to a session-local temporary table.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE maintenance_schedules (
      id integer GENERATED ALWAYS AS IDENTITY, "vehicleId" text NOT NULL,
      title text NOT NULL, status text NOT NULL, deleted_at timestamptz
    ) ON COMMIT DROP`);
    const migration = readFileSync(join(__dirname, '../prisma/migrations/20260929000100_unique_pending_maintenance_schedule/migration.sql'), 'utf8');
    const insert = (vehicle = 'ABC123', title = 'Engine Oil Change', status = 'PENDING', deleted = null) =>
      client.query('INSERT INTO maintenance_schedules ("vehicleId", title, status, deleted_at) VALUES ($1,$2,$3,$4)', [vehicle, title, status, deleted]);
    const rejectsUnique = async (operation) => {
      await client.query('SAVEPOINT duplicate_test');
      await assert.rejects(operation, (error) => error.code === '23505');
      await client.query('ROLLBACK TO SAVEPOINT duplicate_test');
    };
    // Applying the migration fails without changing existing duplicate rows.
    await insert();
    await insert(' abc123 ', ' engine oil change ');
    await rejectsUnique(() => client.query(migration));
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM maintenance_schedules')).rows[0].n, 2);
    await client.query('TRUNCATE maintenance_schedules');
    await client.query(migration);
    await insert();
    await rejectsUnique(() => insert());
    await rejectsUnique(() => insert(' abc123 ', ' ENGINE OIL CHANGE '));
    await insert('XYZ999');
    await insert('ABC123', 'Brake Inspection');
    for (const status of ['CANCELLED', 'COMPLETED', 'DONE', 'IN_PROGRESS']) await insert('ABC123', 'Engine Oil Change', status);
    await insert('ABC123', 'Engine Oil Change', 'PENDING', new Date());
    await rejectsUnique(() => client.query(`UPDATE maintenance_schedules SET status='PENDING' WHERE status='CANCELLED'`));
    await rejectsUnique(() => client.query(`UPDATE maintenance_schedules SET "vehicleId"='ABC123' WHERE "vehicleId"='XYZ999'`));
    await rejectsUnique(() => client.query(`UPDATE maintenance_schedules SET deleted_at=NULL WHERE deleted_at IS NOT NULL`));
    await client.query(`UPDATE maintenance_schedules SET title=title WHERE "vehicleId"='ABC123' AND status='PENDING' AND deleted_at IS NULL`);
    await client.query(`UPDATE maintenance_schedules SET status='CANCELLED' WHERE "vehicleId"='ABC123' AND title='Engine Oil Change' AND status='PENDING' AND deleted_at IS NULL`);
    await insert();
    await client.query('ROLLBACK');
    console.log('PASS: migration rejects existing duplicates; normalized uniqueness, history, edits, reactivation, soft deletion, and cancellation release verified. All test writes rolled back.');
  } finally {
    await client.end();
  }
})().catch((error) => { console.error('Index integration test failed:', error.code || error.name); process.exitCode = 1; });
