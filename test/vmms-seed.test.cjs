// Run with: node --test test/vmms-seed.test.cjs
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { seedVmms } = require('../prisma/seeds/vmms.seed');

test('VMMS seed preserves fixtures without duplicate pending recurrence', async () => {
  const rows = [];
  const normalize = value => value.replace(/^ +| +$/g, '').toLowerCase();
  const sameIdentity = (a, b) => normalize(a.vehicleId) === normalize(b.vehicleId)
    && normalize(a.title) === normalize(b.title);
  const prisma = {
    garage: { findMany: async () => ['Sta. Rosa', 'Marikina', 'Pulilan'].map(name => ({ id: name, name })) },
    vehicle: { findMany: async () => Array.from({ length: 6 }, (_, i) => ({ plateNumber: `TRUCK-${i}` })) },
    mechanic: { findMany: async () => Array.from({ length: 5 }, (_, i) => ({ name: `Mechanic ${i}` })) },
    checklistTemplate: {
      findUnique: async () => null,
      upsert: async ({ create }) => ({ id: create.type, ...create }),
    },
    checklistItem: { createMany: async () => ({ count: 5 }) },
    maintenanceSchedule: {
      deleteMany: async () => { rows.length = 0; },
      create: async ({ data }) => {
        if (data.status === 'PENDING') {
          assert.ok(!rows.some(row => row.status === 'PENDING' && sameIdentity(row, data)),
            `Duplicate pending schedule: ${data.vehicleId} / ${data.title}`);
        }
        const row = { id: String(rows.length + 1), ...data };
        rows.push(row);
        return row;
      },
    },
  };

  await seedVmms(prisma);

  assert.equal(rows.filter(row => !row.previousScheduleId).length, 48);
  const inspections = rows.filter(row => row.vehicleId === 'TRUCK-5' && row.title === 'General Inspection');
  assert.equal(inspections.filter(row => row.status === 'COMPLETED').length, 1);
  assert.equal(inspections.filter(row => row.status === 'PENDING').length, 1);
  assert.equal(inspections.find(row => row.status === 'PENDING').previousScheduleId, undefined);
  const recurring = rows.filter(row => row.previousScheduleId);
  assert.ok(recurring.length > 0);
  assert.equal(recurring.filter(row => row.status === 'OVERDUE').length, 2);
  assert.equal(recurring.filter(row => row.status === 'DUE').length, 2);
  for (const row of recurring) {
    const previous = rows.find(candidate => candidate.id === row.previousScheduleId);
    assert.equal(previous.status, 'COMPLETED');
    assert.ok(sameIdentity(previous, row));
  }
});
