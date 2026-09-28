// Build first. Exercises the real approval service; fixture transactions roll back.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaService } = require('../dist/src/shared/prisma.service');
const { MaintenanceSchedulesService } = require('../dist/src/modules/vmms/maintenance-schedules/maintenance-schedules.service');
const { advanceScheduleDate } = require('../dist/src/modules/vmms/maintenance-schedules/schedule-due');

(async () => {
  const prisma = new PrismaService();
  try {
    const chief = await prisma.user.findFirst({ where: { isActive: true, deletedAt: null, roles: { some: { system: 'VMMS', role: 'CHIEF_MECHANIC' } } } });
    assert.ok(chief, 'An active Chief Mechanic is required in the test database.');
    const actor = { sub: chief.id, roles: [{ role: 'CHIEF_MECHANIC', system: 'VMMS' }] };
    for (const conflict of [false, true]) {
      const id = randomUUID();
      const rollback = new Error('Roll back all recurrence fixtures');
      await assert.rejects(() => prisma.$transaction(async (tx) => {
        const fixture = {
          id, vehicleId: `TEST-${id.slice(0, 8)}`, title: 'Recurrence integration fixture', assignedMechanic: 'Test only',
          chiefMechanicId: chief.id, chiefMechanic: chief.name, status: 'DONE',
          triggerType: 'TIME', intervalType: 'MONTHLY', startReferenceDate: new Date('2025-01-01T00:00:00Z'),
          workOrderProgress: { mechanicSubmitted: true, executionItems: [{ id: 'oil', label: 'Oil', status: 'checked' }] },
        };
        await tx.maintenanceSchedule.create({ data: fixture });
        if (conflict) await tx.maintenanceSchedule.create({ data: { ...fixture, id: randomUUID(), status: 'PENDING', workOrderProgress: undefined } });
        const service = new MaintenanceSchedulesService({ ...tx, $transaction: async (callback) => {
          await tx.$executeRawUnsafe('SAVEPOINT approval');
          try {
            const result = await callback(tx);
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT approval');
            return result;
          } catch (error) {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT approval');
            throw error;
          }
        } });
        service.syncVehicleStatus = async () => {};
        const approve = () => service.updateProgress(id, { action: 'APPROVE', inspectionItems: [{ id: 'oil', status: 'pass' }] }, actor);
        if (conflict) {
          await assert.rejects(approve, (error) => error.getStatus() === 409);
          assert.equal((await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id } })).status, 'DONE');
          assert.equal(await tx.maintenanceSchedule.count({ where: { previousScheduleId: id } }), 0);
        } else {
          const result = await approve();
          assert.equal(result.status, 'COMPLETED');
          const completed = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id } });
          const next = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { previousScheduleId: id } });
          const completionDay = new Date(completed.updatedAt.getTime() + 8 * 3600000).toISOString().slice(0, 10);
          assert.equal(next.startReferenceDate.toISOString().slice(0, 10), completionDay);
          assert.equal(next.startDate.toISOString().slice(0, 10), completionDay);
          assert.equal(result.nextSchedule.dueDate, advanceScheduleDate(next.startReferenceDate, 'MONTHLY').toISOString().slice(0, 10));
          assert.equal(next.status, 'PENDING');
          assert.equal(next.chiefMechanicId, chief.id);
          assert.equal(next.workOrderProgress, null);
          assert.equal(next.totalCost, null);
          assert.equal((await service.createNextRecurringSchedule(tx, completed)).id, next.id);
          assert.equal(await tx.maintenanceSchedule.count({ where: { previousScheduleId: id } }), 1);
        }
        throw rollback;
      }), (error) => error === rollback);
      assert.equal(await prisma.maintenanceSchedule.findUnique({ where: { id } }), null);
      assert.equal(await prisma.maintenanceSchedule.count({ where: { previousScheduleId: id } }), 0);
    }
    console.log('PASS: approval creates one clean linked cycle with the correct due date; conflicting Pending work rolls approval back. No fixtures persisted.');
  } finally {
    await prisma.onApplicationShutdown();
  }
})().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
