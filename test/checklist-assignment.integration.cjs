// Build first, then run with a test DATABASE_URL. All fixture writes roll back.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaService } = require('../dist/src/shared/prisma.service');
const { MaintenanceSchedulesService } = require('../dist/src/modules/vmms/maintenance-schedules/maintenance-schedules.service');

(async () => {
  const prisma = new PrismaService();
  const fixtureId = randomUUID();
  let scheduleId;
  try {
    const mechanic = await prisma.user.findFirst({ where: {
      isActive: true, deletedAt: null, roles: { some: { role: 'MECHANIC', system: 'VMMS' } },
    } });
    assert.ok(mechanic, 'An active VMMS mechanic is required in the test database.');
    const rollback = new Error('Roll back checklist assignment fixtures');
    await assert.rejects(() => prisma.$transaction(async (tx) => {
      const original = await tx.checklistTemplate.create({ data: {
        id: fixtureId, type: `Assignment fixture ${fixtureId}`, items: { create: [{ text: 'Original item', order: 0 }] },
      }, include: { items: true } });
      const replacement = await tx.checklistTemplate.create({ data: {
        type: `Replacement fixture ${fixtureId}`, items: { create: [{ text: 'Replacement item', order: 0 }] },
      }, include: { items: true } });
      const service = new MaintenanceSchedulesService({ ...tx, $queryRaw: tx.$queryRaw.bind(tx), $transaction: (callback) => callback(tx) });
      service.syncVehicleStatus = async () => {};
      const input = { vehicleId: `TEST-${fixtureId.slice(0, 8)}`, title: original.type, assignedDriver: mechanic.name, assignedMechanicId: mechanic.id, startDate: '2099-01-01' };
      // Legacy name-only clients are linked too.
      const created = await service.create(input);
      scheduleId = created.id;
      assert.equal(created.checklistTemplateId, original.id);
      const edited = await service.update(created.id, { ...input, title: replacement.type, checklistTemplateId: replacement.id });
      assert.equal(edited.checklistTemplateId, replacement.id);
      const actor = { sub: mechanic.id, roles: [{ system: 'VMMS', role: 'MECHANIC' }] };
      await service.updateProgress(created.id, { action: 'START' }, actor);
      await assert.rejects(() => service.updateProgress(created.id, {
        action: 'SUBMIT', executionItems: [{ id: original.items[0].id, status: 'checked' }],
      }, actor), (error) => error.message.includes('Replacement item'));
      const submitted = await service.updateProgress(created.id, {
        action: 'SUBMIT', executionItems: [{ id: replacement.items[0].id, label: 'Replacement item', status: 'checked' }],
      }, actor);
      assert.equal(submitted.status, 'DONE');
      const saved = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(saved.checklistTemplateId, replacement.id);
      throw rollback;
    }), (error) => error === rollback);
    assert.equal(await prisma.checklistTemplate.findUnique({ where: { id: fixtureId } }), null);
    assert.equal(await prisma.maintenanceSchedule.findUnique({ where: { id: scheduleId } }), null);
    console.log('PASS: create/edit persist the selected template; submission rejects old checklist items and accepts the assigned checklist. All fixtures rolled back.');
  } finally {
    await prisma.onApplicationShutdown();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
