// One-time, explicitly approved cleanup of NRE 471 General Inspection.
// Rehearse: node scripts/resolve-pending-schedule-duplicate.cjs <approver-email>
// Commit:  node scripts/resolve-pending-schedule-duplicate.cjs <approver-email> --apply
// Then record the manually applied migration using Prisma migrate resolve.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const CANCEL_ID = '24c9b5aa-adac-4a85-be95-27f76b0a2353';
const KEEP_ID = '46dc8844-5473-43a8-bea5-91f74e08fa85';
const MIGRATION = '20260929000100_unique_pending_maintenance_schedule';
const REASON = 'Duplicate Pending General Inspection; retain the monthly recurring schedule linked to the completed inspection.';

// Caller owns the transaction. A failed precondition must roll everything back.
async function resolveDuplicate(client, approverEmail) {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '30s'");
  // Prevent a new duplicate between the data repair and unique-index creation.
  await client.query('LOCK TABLE maintenance_schedules IN ACCESS EXCLUSIVE MODE');
  const approvers = await client.query(`SELECT u.id, u.name, u.email FROM users u
    WHERE LOWER(u.email)=LOWER($1) AND u.is_active=true AND u.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id=u.id
        AND r.role='OPERATIONS' AND r.system='VMMS')`, [approverEmail]);
  if (approvers.rows.length !== 1) throw new Error('Approver must identify one active VMMS Operations user.');
  const { rows } = await client.query('SELECT * FROM maintenance_schedules WHERE id=ANY($1::uuid[])', [[CANCEL_ID, KEEP_ID]]);
  const cancel = rows.find((row) => row.id === CANCEL_ID);
  const keep = rows.find((row) => row.id === KEEP_ID);
  for (const row of [cancel, keep]) {
    if (!row || row.status !== 'PENDING' || row.deleted_at !== null || row.vehicleId !== 'NRE 471' ||
      row.title !== 'General Inspection' || row.work_order_progress !== null ||
      row.parts_cost !== null || row.labor_cost !== null || row.total_cost !== null) {
      throw new Error('Schedules changed since approval; stop and review before cancelling.');
    }
  }
  if (cancel.account_type !== 'IN_HOUSE' || cancel.trigger_type !== 'MANUAL' ||
    keep.account_type !== 'OUTSOURCED' || keep.trigger_type !== 'TIME' || keep.interval_type !== 'MONTHLY' ||
    keep.previous_schedule_id !== '3db38e14-d8e5-4e6b-8ab2-7519b97ccf83' ||
    new Date(cancel.updated_at).toISOString() !== '2026-09-22T10:11:46.421Z' ||
    new Date(keep.updated_at).toISOString() !== '2026-09-22T10:11:46.534Z') {
    throw new Error('Schedule configuration changed since approval; stop and review.');
  }
  const actor = approvers.rows[0];
  // Retain audit provenance in the schedule's existing JSON record. This is a
  // one-time repair, not a substitute for implementing the app cancellation UI.
  const result = await client.query(`UPDATE maintenance_schedules
    SET status='CANCELLED', updated_at=clock_timestamp(),
      work_order_progress=jsonb_build_object('auditTrail', jsonb_build_array(jsonb_build_object(
        'action', 'CANCEL', 'previousStatus', 'PENDING', 'newStatus', 'CANCELLED',
        'reason', $2::text, 'approvedByUserId', $3::text, 'approvedByEmail', $4::text,
        'approvedByName', $5::text, 'timestamp', clock_timestamp(),
        'source', 'User-approved data repair executed by Codex', 'retainedScheduleId', $6::text)))
    WHERE id=$1::uuid RETURNING id, status, deleted_at, work_order_progress`,
  [CANCEL_ID, REASON, actor.id, actor.email, actor.name, KEEP_ID]);
  const migration = readFileSync(join(__dirname, '../prisma/migrations', MIGRATION, 'migration.sql'), 'utf8');
  await client.query(migration);
  const remaining = await client.query(`SELECT COUNT(*)::int AS count FROM (
    SELECT 1 FROM maintenance_schedules WHERE status='PENDING' AND deleted_at IS NULL
    GROUP BY LOWER(BTRIM("vehicleId")), LOWER(BTRIM(title)) HAVING COUNT(*)>1
  ) duplicates`);
  if (remaining.rows[0].count !== 0) throw new Error('Pending duplicates remain.');
  return { cancelledId: result.rows[0].id, retainedId: KEEP_ID, reason: REASON, migration: MIGRATION };
}

module.exports = { resolveDuplicate, CANCEL_ID, KEEP_ID, MIGRATION, REASON };

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const { Client } = require('pg');
  (async () => {
    const [email, flag] = process.argv.slice(2);
    if (!email || (flag && flag !== '--apply')) throw new Error('Supply the confirmed Operations approver email, optionally followed by --apply.');
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      await client.query('BEGIN');
      const result = await resolveDuplicate(client, email);
      await client.query(flag === '--apply' ? 'COMMIT' : 'ROLLBACK');
      console.log(JSON.stringify({ committed: flag === '--apply', ...result }));
      if (flag === '--apply') console.log(`Record the applied migration: npx prisma migrate resolve --applied ${MIGRATION}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
  })().catch((error) => { console.error(error.code ? `Database operation failed (${error.code}); transaction rolled back.` : error.message); process.exitCode = 1; });
}
