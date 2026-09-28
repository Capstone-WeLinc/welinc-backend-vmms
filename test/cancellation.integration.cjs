// Build first, then run: node test/cancellation.integration.cjs
// Exercises the real service and PostgreSQL transaction. All fixture writes roll back.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaService } = require('../dist/src/shared/prisma.service');
const { MaintenanceSchedulesService } = require('../dist/src/modules/vmms/maintenance-schedules/maintenance-schedules.service');

(async () => {
  const prisma = new PrismaService();
  try {
    const user = await prisma.user.findFirst({ where: {
      isActive: true, deletedAt: null, roles: { some: { system: 'VMMS', role: 'OPERATIONS' } },
    }, select: { id: true, name: true, email: true } });
    assert.ok(user, 'A test database with an active Operations user is required.');
    const actor = { sub: user.id, roles: [{ role: 'OPERATIONS', system: 'VMMS' }] };
    for (const failAudit of [false, true]) {
      const id = randomUUID();
      const rollback = new Error(failAudit ? 'injected audit failure' : 'rollback successful rehearsal');
      const service = new MaintenanceSchedulesService({
        $transaction: (callback) => prisma.$transaction(async (tx) => {
          await tx.maintenanceSchedule.create({ data: {
            id, vehicleId: `TEST-${id.slice(0, 8)}`, title: 'Cancellation integration fixture',
            assignedMechanic: 'Test only', status: 'PENDING',
          } });
          const scoped = failAudit ? {
            ...tx,
            maintenanceScheduleCancellation: {
              create: async () => {
                assert.equal((await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id } })).status, 'CANCELLED');
                throw rollback;
              },
            },
          } : tx;
          const result = await callback(scoped);
          assert.equal(result.status, 'CANCELLED');
          assert.equal(result.cancellations.length, 1);
          const entry = result.cancellations[0];
          assert.equal(entry.actorId, user.id);
          assert.equal(entry.actorEmail, user.email);
          assert.equal(entry.reason, 'Integration test cancellation');
          assert.equal(entry.previousStatus, 'PENDING');
          assert.ok(entry.createdAt instanceof Date);
          const saved = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id } });
          assert.equal(saved.status, 'CANCELLED');
          assert.equal(saved.deletedAt, null);
          throw rollback;
        }),
      });
      await assert.rejects(() => service.cancel(id, ' Integration test cancellation ', actor), (error) => error === rollback);
      assert.equal(await prisma.maintenanceSchedule.findUnique({ where: { id } }), null);
      assert.equal(await prisma.maintenanceScheduleCancellation.count({ where: { scheduleId: id } }), 0);
    }
    console.log('PASS: real cancellation transaction records identity/reason/time, preserves history, and rolls back on audit failure. No fixtures persisted.');
  } finally {
    await prisma.onApplicationShutdown();
  }
})().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
