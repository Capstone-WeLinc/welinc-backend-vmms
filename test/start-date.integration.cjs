// Build first. Tests use temporary fixture records within a rolled-back transaction.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaService } = require('../dist/src/shared/prisma.service');
const { MaintenanceSchedulesService } = require('../dist/src/modules/vmms/maintenance-schedules/maintenance-schedules.service');

(async () => {
  const prisma = new PrismaService();
  const fixtureId = randomUUID();
  try {
    const mechanic = await prisma.user.findFirst({ where: { isActive: true, deletedAt: null, roles: { some: { system: 'VMMS', role: 'MECHANIC' } } } });
    assert.ok(mechanic);
    const rollback = new Error('Rollback start-date fixtures');
    await assert.rejects(() => prisma.$transaction(async (tx) => {
      const template = await tx.checklistTemplate.create({ data: {
        id: fixtureId, type: `Start date fixture ${fixtureId}`, items: { create: [{ text: 'Check item', order: 0 }] },
      } });
      const service = new MaintenanceSchedulesService({ ...tx, $queryRaw: tx.$queryRaw.bind(tx), $transaction: (callback) => callback(tx) });
      service.syncVehicleStatus = async () => {};
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      for (const triggerType of ['MANUAL', 'TIME', 'ODOMETER']) {
        const input = { vehicleId: `TEST-${triggerType}-${fixtureId.slice(0, 8)}`, title: template.type, checklistTemplateId: template.id, assignedDriver: mechanic.name, assignedMechanicId: mechanic.id, triggerType };
        await assert.rejects(() => service.create(input), /Schedule start date is required/);
        await assert.rejects(() => service.create({ ...input, startDate: '2020-01-01' }), /Schedule date cannot be in the past/);
        const created = await service.create({ ...input, startDate: today });
        assert.equal(created.startDate, today);
        const stored = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id: created.id } });
        assert.equal(stored.startDate.toISOString(), `${today}T00:00:00.000Z`);
        await tx.maintenanceSchedule.update({ where: { id: created.id }, data: { startDate: new Date('2020-01-01T00:00:00Z') } });
        assert.equal((await service.update(created.id, input)).startDate, '2020-01-01');
        await assert.rejects(() => service.update(created.id, { ...input, startDate: '2020-01-02' }), /Schedule date cannot be in the past/);
        await tx.maintenanceSchedule.update({ where: { id: created.id }, data: { startDate: null } });
        await assert.rejects(() => service.update(created.id, input), /Schedule start date is required/);
        assert.equal((await service.update(created.id, { ...input, startDate: today })).startDate, today);
      }
      throw rollback;
    }), (error) => error === rollback);
    assert.equal(await prisma.checklistTemplate.findUnique({ where: { id: fixtureId } }), null);
    console.log('PASS: all schedule types require and persist a start date; historical edits preserve unchanged dates; legacy missing dates require input. Fixtures rolled back.');
  } finally { await prisma.onApplicationShutdown(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
