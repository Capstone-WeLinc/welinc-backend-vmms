// Build first. All fixture data and status changes are rolled back.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaService } = require('../dist/src/shared/prisma.service');
const { MaintenanceSchedulesService } = require('../dist/src/modules/vmms/maintenance-schedules/maintenance-schedules.service');
const { scheduleDue } = require('../dist/src/modules/vmms/maintenance-schedules/schedule-due');

(async () => {
  const prisma = new PrismaService();
  const fixtureId = randomUUID();
  let scheduleId;
  try {
    const account = (role) => prisma.user.findFirst({ where: { isActive: true, deletedAt: null, roles: { some: { role, system: 'VMMS' } } } });
    const [mechanic, chief] = await Promise.all([account('MECHANIC'), account('CHIEF_MECHANIC')]);
    assert.ok(mechanic && chief);
    const rollback = new Error('Rollback time interval fixtures');
    await assert.rejects(() => prisma.$transaction(async (tx) => {
      const template = await tx.checklistTemplate.create({ data: { id: fixtureId, type: `Time fixture ${fixtureId}`, items: { create: [{ text: 'Check oil', order: 0 }] } }, include: { items: true } });
      const service = new MaintenanceSchedulesService({ ...tx, $queryRaw: tx.$queryRaw.bind(tx), $transaction: (callback) => callback(tx) });
      service.syncVehicleStatus = async () => {};
      const input = { vehicleId: `TIME-${fixtureId.slice(0, 8)}`, title: template.type, checklistTemplateId: template.id,
        assignedDriver: mechanic.name, assignedMechanicId: mechanic.id, chiefMechanicId: chief.id,
        triggerType: 'TIME', startDate: '2099-01-01', startReferenceDate: '2026-01-31' };
      const created = await service.create(input);
      scheduleId = created.id;
      assert.equal(created.timeIntervalValue, 3);
      assert.equal(created.timeIntervalUnit, 'MONTHS');
      assert.equal(scheduleDue(await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id: scheduleId } })).dueDate, '2026-04-30');
      const updated = await service.update(scheduleId, { ...input, timeIntervalValue: 45, timeIntervalUnit: 'DAYS' });
      assert.equal(updated.timeIntervalValue, 45);
      assert.equal(updated.intervalType, null);
      assert.equal(scheduleDue(await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id: scheduleId } })).dueDate, '2026-03-17');
      await assert.rejects(() => service.update(scheduleId, { ...input, timeIntervalValue: 0, timeIntervalUnit: 'DAYS' }), /positive whole number/);
      await tx.maintenanceSchedule.update({ where: { id: scheduleId }, data: {
        status: 'DONE', workOrderProgress: { mechanicSubmitted: true, executionItems: [{ id: template.items[0].id, label: 'Check oil', status: 'checked' }] },
      } });
      const approved = await service.updateProgress(scheduleId, { action: 'APPROVE', inspectionItems: [{ id: template.items[0].id, status: 'pass' }] }, { sub: chief.id, roles: [{ role: 'CHIEF_MECHANIC', system: 'VMMS' }] });
      const next = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { previousScheduleId: scheduleId } });
      assert.equal(next.timeIntervalValue, 45);
      assert.equal(next.timeIntervalUnit, 'DAYS');
      assert.equal(next.intervalType, null);
      assert.equal(approved.nextSchedule.dueDate, scheduleDue(next).dueDate);
      const list = await service.findAll({ sub: chief.id, roles: [{ role: 'CHIEF_MECHANIC', system: 'VMMS' }] });
      assert.equal(list.find((row) => row.id === next.id).timeIntervalValue, 45);
      throw rollback;
    }), (error) => error === rollback);
    assert.equal(await prisma.checklistTemplate.findUnique({ where: { id: fixtureId } }), null);
    assert.equal(await prisma.maintenanceSchedule.findUnique({ where: { id: scheduleId } }), null);
    console.log('PASS: default and custom intervals persist; invalid edits fail; completion carries the custom interval into the next cycle. Fixtures rolled back.');
  } finally { await prisma.onApplicationShutdown(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
