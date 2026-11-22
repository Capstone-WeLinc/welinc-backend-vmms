// Run with: node --test test/vmms-seed.test.cjs
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { seedVmms } = require('../prisma/seeds/vmms.seed');

test('VMMS seed preserves fixtures without duplicate pending recurrence', async () => {
  const rows = [];
  const templateUpserts = [];
  const templateRows = new Map();
  const checklistItems = new Map();
  const normalize = value => value.replace(/^ +| +$/g, '').toLowerCase();
  const sameIdentity = (a, b) => normalize(a.vehicleId) === normalize(b.vehicleId)
    && normalize(a.title) === normalize(b.title);
  const prisma = {
    garage: { findMany: async () => ['Sta. Rosa', 'Marikina', 'Pulilan'].map(name => ({ id: name, name })) },
    vehicle: { findMany: async () => [
      ['NDG 5821', 'Marikina'], ['CAK 9043', 'Sta. Rosa'], ['WOB 2947', 'Pulilan'],
      ['PXW 382', 'Marikina'], ['TGD 908', 'Sta. Rosa'], ['NRE 471', 'Pulilan'],
    ].map(([plateNumber, branch]) => ({ plateNumber, garageId: branch })) },
    mechanic: { findMany: async () => ['Juan dela Cruz', 'Pedro Santos', 'Rommel Cruz', 'Isabel Reyes', 'Carl Santos'].map((name, i) => ({
      name, userId: `user-${i}`, isOutsourced: false,
    })) },
    user: { findMany: async () => [{ id: 'chief-user', name: 'Chief Mechanic', email: 'chief@example.test' }] },
    checklistTemplate: {
      findUnique: async ({ where }) => templateRows.get(where.type) ?? null,
      upsert: async args => {
        templateUpserts.push(args);
        const existing = templateRows.get(args.where.type);
        const row = existing ?? { id: args.create.type, ...args.create };
        templateRows.set(args.where.type, row);
        return row;
      },
    },
    checklistItem: {
      findMany: async ({ where }) => checklistItems.get(where.checklistTemplateId) ?? [],
      createMany: async ({ data }) => {
        const existing = checklistItems.get(data[0].checklistTemplateId) ?? [];
        checklistItems.set(data[0].checklistTemplateId, [
          ...existing,
          ...data.map(({ text }) => ({ text })),
        ]);
        return { count: data.length };
      },
    },
    maintenanceSchedule: {
      count: async () => rows.length,
      upsert: async ({ where, create }) => {
        const existing = where.id
          ? rows.find(row => row.id === where.id)
          : rows.find(row => row.previousScheduleId === where.previousScheduleId);
        if (existing) return existing;
        const data = create;
        if (data.status === 'PENDING') {
          assert.ok(!rows.some(row => row.status === 'PENDING' && sameIdentity(row, data)),
            `Duplicate pending schedule: ${data.vehicleId} / ${data.title}`);
        }
        const row = { ...data };
        rows.push(row);
        return row;
      },
    },
    $queryRaw: async () => [{ logNumber: 'MLG-20260101-0001' }],
  };

  await seedVmms(prisma);

  assert.equal(templateUpserts.length, 5);
  for (const template of templateUpserts) assert.deepEqual(template.update, {});
  assert.equal(rows.filter(row => !row.previousScheduleId).length, 48);
  const garageByPlate = new Map([
    ['NDG 5821', 'Marikina'], ['CAK 9043', 'Sta. Rosa'], ['WOB 2947', 'Pulilan'],
    ['PXW 382', 'Marikina'], ['TGD 908', 'Sta. Rosa'], ['NRE 471', 'Pulilan'],
  ]);
  for (const row of rows) assert.equal(row.garageId, garageByPlate.get(row.vehicleId));
  const inspections = rows.filter(row => row.vehicleId === 'NRE 471' && row.title === 'General Inspection');
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

  const firstRunCount = rows.length;
  await seedVmms(prisma);
  assert.equal(rows.length, firstRunCount);
  assert.equal(templateUpserts.length, 5);
});
