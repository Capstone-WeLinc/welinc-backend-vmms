import { MaintenanceSchedulesService } from './maintenance-schedules.service';

describe('Schedule checklist assignment', () => {
  const template = { id: 'template-a', type: 'Oil Change', items: [{ id: 'oil' }] };
  const input = { vehicleId: 'ABC123', title: 'Oil Change', assignedDriver: 'Mechanic', checklistTemplateId: template.id, startDate: '2099-01-01' };
  let service: MaintenanceSchedulesService;
  let db: any;
  let previous: any;
  beforeEach(() => {
    previous = { ...input, startDate: new Date('2099-01-01T00:00:00Z'), id: 'schedule', status: 'PENDING', assignedMechanicId: 'mechanic', createdAt: new Date(), updatedAt: new Date() };
    db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      checklistTemplate: { findMany: jest.fn().mockResolvedValue([template]) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'mechanic', name: 'Mechanic' }]) },
      maintenanceSchedule: {
        findUniqueOrThrow: jest.fn().mockImplementation(async () => previous),
        create: jest.fn().mockImplementation(async ({ data }) => ({ ...previous, ...data })),
        update: jest.fn().mockImplementation(async ({ data }) => ({ ...previous, ...data })),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => callback(db)),
    };
    service = new MaintenanceSchedulesService(db);
    jest.spyOn(service as any, 'syncVehicleStatus').mockResolvedValue(undefined);
  });
  it.each(['create', 'update'] as const)('%s persists the chosen ID and canonical type', async (method) => {
    const data = { ...input, title: ' oil change ' };
    const result = method === 'create' ? await service.create(data) : await service.update(previous.id, data);
    expect(result.checklistTemplateId).toBe(template.id);
    expect(db.maintenanceSchedule[method]).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ title: template.type, checklistTemplateId: template.id }) }));
    expect(db.checklistTemplate.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: template.id, deletedAt: null },
      select: expect.objectContaining({ items: { where: { deletedAt: null }, select: { id: true }, take: 1 } }),
    }));
  });
  it('resolves an unambiguous template for older clients that send only its name', async () => {
    await service.create({ ...input, checklistTemplateId: undefined });
    expect(db.checklistTemplate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { type: { equals: input.title, mode: 'insensitive' }, deletedAt: null } }));
    expect(db.maintenanceSchedule.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ checklistTemplateId: template.id }) }));
  });
  it('preserves the saved ID on an unchanged legacy edit', async () => {
    await service.update(previous.id, { ...input, checklistTemplateId: undefined });
    expect(db.checklistTemplate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: template.id, deletedAt: null } }));
  });
  it('repairs an unlinked Pending schedule when explicitly saved', async () => {
    previous.checklistTemplateId = null;
    await service.update(previous.id, { ...input, checklistTemplateId: undefined });
    expect(db.maintenanceSchedule.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ checklistTemplateId: template.id }) }));
  });
  it.each(['create', 'update'] as const)('%s rejects unavailable or archived templates', async (method) => {
    db.checklistTemplate.findMany.mockResolvedValue([]);
    await expect(method === 'create' ? service.create(input) : service.update(previous.id, input)).rejects.toThrow('active checklist template');
    expect(db.maintenanceSchedule[method]).not.toHaveBeenCalled();
  });
  it.each(['create', 'update'] as const)('%s rejects a template without active items', async (method) => {
    db.checklistTemplate.findMany.mockResolvedValue([{ ...template, items: [] }]);
    await expect(method === 'create' ? service.create(input) : service.update(previous.id, input)).rejects.toThrow('no active items');
    expect(db.maintenanceSchedule[method]).not.toHaveBeenCalled();
  });
  it('rejects ambiguous case-insensitive template names', async () => {
    db.checklistTemplate.findMany.mockResolvedValue([template, { ...template, id: 'template-b', type: 'OIL CHANGE' }]);
    await expect(service.create({ ...input, checklistTemplateId: undefined })).rejects.toThrow('Select one active');
  });
  it('does not silently substitute another template when the supplied ID mismatches the type', async () => {
    db.checklistTemplate.findMany.mockResolvedValue([{ ...template, type: 'Brake Inspection' }]);
    await expect(service.create(input)).rejects.toThrow('matching the maintenance type');
    expect(db.checklistTemplate.findMany).toHaveBeenCalledTimes(1);
  });
  it('updates a Pending schedule to the newly selected template', async () => {
    db.checklistTemplate.findMany.mockResolvedValue([{ ...template, id: 'template-b', type: 'Brake Inspection' }]);
    await service.update(previous.id, { ...input, checklistTemplateId: 'template-b', title: 'Brake Inspection' });
    expect(db.maintenanceSchedule.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ checklistTemplateId: 'template-b', title: 'Brake Inspection' }) }));
  });
  it.each(['IN_PROGRESS', 'DONE'] as const)('does not switch the checklist on %s work', async (status) => {
    previous.status = status;
    db.checklistTemplate.findMany.mockResolvedValue([{ ...template, id: 'template-b', type: 'Brake Inspection' }]);
    await expect(service.update(previous.id, { ...input, status, checklistTemplateId: 'template-b', title: 'Brake Inspection' })).rejects.toThrow();
    expect(db.maintenanceSchedule.update).not.toHaveBeenCalled();
  });
});
