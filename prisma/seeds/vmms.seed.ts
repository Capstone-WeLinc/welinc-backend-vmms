import { stateForStorage } from '../../src/modules/vmms/maintenance-schedules/work-order-state';
import {
  PrismaClient,
  MaintenanceStatus,
  AccountType,
  MaintenanceTriggerType,
  MaintenanceIntervalType,
  SystemType,
  UserRole,
} from '@prisma/client';

export async function seedVmms(prisma: PrismaClient) {
  console.log('Creating checklist templates for VMMS...');

  // Fetch relations from DB
  const garages = await prisma.garage.findMany({ orderBy: { name: 'asc' } });
  const seededVehiclePlates = ['NDG 5821', 'CAK 9043', 'WOB 2947', 'PXW 382', 'TGD 908', 'NRE 471'];
  const vehicleRows = await prisma.vehicle.findMany({ where: { plateNumber: { in: seededVehiclePlates } } });
  const vehiclesByPlate = new Map(vehicleRows.map((vehicle) => [vehicle.plateNumber, vehicle]));
  const missingPlate = seededVehiclePlates.find((plate) => !vehiclesByPlate.has(plate));
  if (missingPlate) throw new Error(`Cannot seed maintenance schedules: sample vehicle "${missingPlate}" is missing.`);
  const vehicles = seededVehiclePlates.map((plate) => vehiclesByPlate.get(plate)!);
  const seededMechanicNames = ['Juan dela Cruz', 'Pedro Santos', 'Rommel Cruz', 'Isabel Reyes', 'Carl Santos'];
  const mechanicRows = await prisma.mechanic.findMany({ where: { name: { in: seededMechanicNames }, isOutsourced: false }, orderBy: { name: 'asc' } });
  const mechanicsByName = new Map(mechanicRows.map((mechanic) => [mechanic.name, mechanic]));
  const missingMechanic = seededMechanicNames.find((name) => !mechanicsByName.has(name));
  if (missingMechanic) throw new Error(`Cannot seed maintenance schedules: in-house mechanic "${missingMechanic}" is missing.`);
  const mechanics = seededMechanicNames.map((name) => mechanicsByName.get(name)!);
  const chiefMechanics = await prisma.user.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      roles: { some: { system: SystemType.VMMS, role: UserRole.CHIEF_MECHANIC } },
    },
    orderBy: { email: 'asc' },
    select: { id: true, name: true, email: true },
  });
  if (!chiefMechanics.length) {
    throw new Error('Cannot seed maintenance schedules: no active VMMS Chief Mechanic users exist. Run the users seed first.');
  }

  const checklistTemplatesData = [
    {
      type: 'Oil Change',
      items: [
        'Drain old engine oil',
        'Replace oil filter',
        'Fill with new engine oil',
        'Check for oil leaks',
        'Reset maintenance light',
      ],
    },
    {
      type: 'Brake Inspection',
      items: [
        'Check brake pad thickness',
        'Inspect brake rotors for wear',
        'Check brake fluid level and condition',
        'Inspect brake lines for leaks',
        'Test brake pedal feel',
      ],
    },
    {
      type: 'Tire Rotation',
      items: [
        'Check tire pressure on all tires',
        'Inspect tire tread depth',
        'Rotate tires according to pattern',
        'Torque lug nuts to specification',
        'Check alignment if irregular wear found',
      ],
    },
    {
      type: 'Engine Tune-up',
      items: [
        'Replace spark plugs',
        'Inspect ignition coils/wires',
        'Replace air filter',
        'Clean fuel injectors (if necessary)',
        'Check engine timing and idle',
      ],
    },
    {
      type: 'General Inspection',
      items: [
        'Check all fluid levels',
        'Inspect belts and hoses',
        'Test battery and charging system',
        'Check exterior and interior lights',
        'Inspect wiper blades',
      ],
    },
  ];

  const seededTemplates: any[] = [];
  for (const templateData of checklistTemplatesData) {
    const existing = await prisma.checklistTemplate.findUnique({
      where: { type: templateData.type },
    });

    if (existing) {
      await prisma.checklistItem.deleteMany({
        where: { checklistTemplateId: existing.id },
      });
    }

    const t = await prisma.checklistTemplate.upsert({
      where: { type: templateData.type },
      update: { deletedAt: null },
      create: {
        type: templateData.type,
      },
    });

    await prisma.checklistItem.createMany({
      data: templateData.items.map((text, index) => ({
        checklistTemplateId: t.id,
        text,
        order: index,
      })),
    });

    seededTemplates.push(t);
  }

  console.log(`  Created ${seededTemplates.length} checklist templates for VMMS\n`);

  console.log('Creating sample maintenance schedules for VMMS...');

  // Clean old schedules first
  await prisma.maintenanceSchedule.deleteMany();

  const oilChangeTemplate = seededTemplates.find(t => t.type === 'Oil Change');
  const brakeInspectionTemplate = seededTemplates.find(t => t.type === 'Brake Inspection');
  const tireRotationTemplate = seededTemplates.find(t => t.type === 'Tire Rotation');
  const engineTuneupTemplate = seededTemplates.find(t => t.type === 'Engine Tune-up');
  const generalInspectionTemplate = seededTemplates.find(t => t.type === 'General Inspection');

  const staRosaGarage = garages.find(g => g.name === 'Sta. Rosa');
  const marikinaGarage = garages.find(g => g.name === 'Marikina');
  const pulilanGarage = garages.find(g => g.name === 'Pulilan') ?? garages[2];

  const resolveSeedMechanicId = (
    assignedMechanic: string,
    accountType: AccountType,
  ): string | null => {
    if (accountType === AccountType.OUTSOURCED) return null;

    const normalizedName = assignedMechanic.trim().toLowerCase();
    const matches = mechanics.filter(
      (mechanic) =>
        mechanic.name.trim().toLowerCase() === normalizedName &&
        !mechanic.isOutsourced &&
        mechanic.userId,
    );
    const userId = matches.length === 1 ? matches[0].userId : null;
    if (!userId) {
      throw new Error(
        `Seeded work order mechanic "${assignedMechanic}" must match exactly one in-house mechanic user.`,
      );
    }
    return userId;
  };

  const maintenanceSchedulesData = [
    {
      vehicleId: vehicles[0].plateNumber, // NDG 5821
      title: oilChangeTemplate?.type ?? 'Oil Change',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-06-22T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name, // Juan dela Cruz
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: oilChangeTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 45000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 10000,
      bufferDistanceKm: 500,
      startingReferenceReadingKm: 40000,
    },
    {
      vehicleId: vehicles[1].plateNumber, // CAK 9043
      title: brakeInspectionTemplate?.type ?? 'Brake Inspection',
      status: MaintenanceStatus.IN_PROGRESS,
      createdAt: new Date('2026-06-19T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name, // Pedro Santos
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: brakeInspectionTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 72500,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 15000,
      startingReferenceReadingKm: 60000,
    },
    {
      vehicleId: vehicles[2].plateNumber, // WOB 2947
      title: generalInspectionTemplate?.type ?? 'General Inspection',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-06-14T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name, // Pedro Santos
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 32000,
      triggerType: MaintenanceTriggerType.MANUAL,
      partsCost: 650.0,
      laborCost: 320.0,
      totalCost: 970.0,
      workOrderProgress: {
        checklist: [
          {
            item: 'Check all fluid levels',
            completed: true,
            notes: 'Washer fluid topped up and coolant level confirmed.',
            selectedOption: 'yes',
          },
          {
            item: 'Inspect belts and hoses',
            completed: true,
            notes: 'No cracks found. Tightened the serpentine belt.',
            selectedOption: 'yes',
          },
          {
            item: 'Test battery and charging system',
            completed: true,
            notes: 'Battery voltage stable at 13.8V.',
            selectedOption: 'yes',
          },
          {
            item: 'Check exterior and interior lights',
            completed: true,
            notes: 'All lights operational except one fog lamp replaced.',
            selectedOption: 'no',
          },
          {
            item: 'Inspect wiper blades',
            completed: true,
            notes: 'Front wiper blades replaced with new set.',
            selectedOption: 'yes',
          },
        ],
      },
    },
    {
      vehicleId: vehicles[3].plateNumber, // PXW 382
      title: generalInspectionTemplate?.type ?? 'General Inspection',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
      assignedMechanic: mechanics[3].name, // Isabel Reyes
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 18500,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.MONTHLY,
      startReferenceDate: new Date('2026-06-01T00:00:00.000Z'),
      partsCost: 480.0,
      laborCost: 290.0,
      totalCost: 770.0,
      workOrderProgress: {
        checklist: [
          {
            item: 'Check all fluid levels',
            completed: true,
            note: 'Oil level checked and within range.',
            selectedOption: 'yes',
          },
          {
            item: 'Inspect belts and hoses',
            completed: true,
            note: 'Minor wear on hose, no replacement needed.',
            selectedOption: 'yes',
          },
          {
            item: 'Test battery and charging system',
            completed: true,
            note: 'Alternator output normal.',
            selectedOption: 'yes',
          },
          {
            item: 'Check exterior and interior lights',
            completed: true,
            note: 'Replaced one burned-out interior bulb.',
            selectedOption: 'yes',
          },
          {
            item: 'Inspect wiper blades',
            completed: true,
            note: 'Wipers good; no action required.',
            selectedOption: 'yes',
          },
        ],
      },
    },
    {
      vehicleId: vehicles[4].plateNumber, // TGD 908
      title: seededTemplates.find(t => t.type === 'Engine Tune-up')?.type ?? 'Engine Tune-up',
      status: MaintenanceStatus.OVERDUE,
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name, // Juan dela Cruz
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: seededTemplates.find(t => t.type === 'Engine Tune-up')?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 92200,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 20000,
      bufferDistanceKm: 1000,
      startingReferenceReadingKm: 70000,
    },
    {
      vehicleId: vehicles[5].plateNumber, // NRE 471
      title: generalInspectionTemplate?.type ?? 'General Inspection',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-06-28T00:00:00.000Z'),
      assignedMechanic: mechanics[4].name, // Carl Santos
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 145100,
      triggerType: MaintenanceTriggerType.MANUAL,
    },
    {
      vehicleId: vehicles[0].plateNumber, // NDG 5821
      title: tireRotationTemplate?.type ?? 'Tire Rotation',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      assignedMechanic: mechanics[2].name, // Rommel Cruz
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: tireRotationTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 51000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 8000,
      bufferDistanceKm: 400,
      startingReferenceReadingKm: 43000,
    },
    {
      vehicleId: vehicles[1].plateNumber, // CAK 9043
      title: engineTuneupTemplate?.type ?? 'Engine Tune-up',
      status: MaintenanceStatus.IN_PROGRESS,
      createdAt: new Date('2026-06-27T00:00:00.000Z'),
      assignedMechanic: mechanics[3].name, // Isabel Reyes
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: engineTuneupTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 63800,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 12000,
      bufferDistanceKm: 800,
      startingReferenceReadingKm: 50000,
    },
    {
      vehicleId: vehicles[2].plateNumber, // WOB 2947
      title: brakeInspectionTemplate?.type ?? 'Brake Inspection',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-06-21T00:00:00.000Z'),
      assignedMechanic: mechanics[2].name, // Rommel Cruz
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: brakeInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 34800,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 6000,
      bufferDistanceKm: 300,
      startingReferenceReadingKm: 28800,
      partsCost: 420.0,
      laborCost: 260.0,
      totalCost: 680.0,
      workOrderProgress: {
        checklist: [
          {
            item: 'Check brake pad thickness',
            completed: true,
            notes: 'Brake pads at 7mm, within acceptable limit.',
            selectedOption: 'yes',
          },
          {
            item: 'Inspect brake rotors for wear',
            completed: true,
            notes: 'Rotors cleaned and minor scoring addressed.',
            selectedOption: 'yes',
          },
          {
            item: 'Check brake fluid level and condition',
            completed: true,
            notes: 'Fluid topped off and no contamination found.',
            selectedOption: 'yes',
          },
          {
            item: 'Inspect brake lines for leaks',
            completed: true,
            notes: 'No leaks detected on the brake lines.',
            selectedOption: 'yes',
          },
          {
            item: 'Test brake pedal feel',
            completed: true,
            notes: 'Pedal response is firm and even.',
            selectedOption: 'yes',
          },
        ],
      },
    },
    {
      vehicleId: vehicles[3].plateNumber, // PXW 382
      title: oilChangeTemplate?.type ?? 'Oil Change',
      status: MaintenanceStatus.OVERDUE,
      createdAt: new Date('2026-06-16T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name, // Pedro Santos
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: oilChangeTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 23650,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.MONTHLY,
      startReferenceDate: new Date('2026-05-16T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[4].plateNumber, // TGD 908
      title: generalInspectionTemplate?.type ?? 'General Inspection',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-06-24T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name, // Juan dela Cruz
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 98500,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.QUARTERLY,
      startReferenceDate: new Date('2026-03-24T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[5].plateNumber, // NRE 471
      title: tireRotationTemplate?.type ?? 'Tire Rotation',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-06-18T00:00:00.000Z'),
      assignedMechanic: mechanics[4].name, // Carl Santos
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: tireRotationTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 154200,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.SEMI_ANNUALLY,
      startReferenceDate: new Date('2026-06-01T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[0].plateNumber, // NDG 5821
      title: engineTuneupTemplate?.type ?? 'Engine Tune-up',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: engineTuneupTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 41000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 20000,
      partsCost: 820.0,
      laborCost: 450.0,
      totalCost: 1270.0,
      workOrderProgress: {
        checklist: [
          { item: 'Replace spark plugs', completed: true, notes: 'New spark plugs installed.', selectedOption: 'yes' },
          { item: 'Inspect ignition coils/wires', completed: true, notes: 'Coils tested good.', selectedOption: 'yes' },
          { item: 'Replace air filter', completed: true, notes: 'Air filter replaced.', selectedOption: 'yes' },
          { item: 'Clean fuel injectors', completed: true, notes: 'Cleaned with service fluid.', selectedOption: 'yes' },
          { item: 'Check engine timing and idle', completed: true, notes: 'Idle set to 750 RPM.', selectedOption: 'yes' },
        ],
      },
    },
    {
      vehicleId: vehicles[1].plateNumber, // CAK 9043
      title: oilChangeTemplate?.type ?? 'Oil Change',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-04-12T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: oilChangeTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 65000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 10000,
      partsCost: 550.0,
      laborCost: 250.0,
      totalCost: 800.0,
      workOrderProgress: {
        checklist: [
          { item: 'Drain old engine oil', completed: true, notes: 'Drained 7L synthetic oil.', selectedOption: 'yes' },
          { item: 'Replace oil filter', completed: true, notes: 'New spin-on filter.', selectedOption: 'yes' },
          { item: 'Fill with new engine oil', completed: true, notes: 'Refilled 15W-40 oil.', selectedOption: 'yes' },
          { item: 'Check for oil leaks', completed: true, notes: 'No leaks found.', selectedOption: 'yes' },
          { item: 'Reset maintenance light', completed: true, notes: 'Service light cleared.', selectedOption: 'yes' },
        ],
      },
    },
    {
      vehicleId: vehicles[2].plateNumber, // WOB 2947
      title: tireRotationTemplate?.type ?? 'Tire Rotation',
      status: MaintenanceStatus.DUE,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      assignedMechanic: mechanics[2].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: tireRotationTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 36000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 8000,
      bufferDistanceKm: 400,
      startingReferenceReadingKm: 28000,
    },
    {
      vehicleId: vehicles[3].plateNumber, // PXW 382
      title: brakeInspectionTemplate?.type ?? 'Brake Inspection',
      status: MaintenanceStatus.IN_PROGRESS,
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      assignedMechanic: mechanics[3].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: brakeInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 24200,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 12000,
      startingReferenceReadingKm: 12000,
    },
    {
      vehicleId: vehicles[4].plateNumber, // TGD 908
      title: oilChangeTemplate?.type ?? 'Oil Change',
      status: MaintenanceStatus.OVERDUE,
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: oilChangeTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 99500,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 10000,
      bufferDistanceKm: 500,
      startingReferenceReadingKm: 88000,
    },
    {
      vehicleId: vehicles[5].plateNumber, // NRE 471
      title: generalInspectionTemplate?.type ?? 'General Inspection',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
      assignedMechanic: mechanics[4].name,
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 142000,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.MONTHLY,
      partsCost: 350.0,
      laborCost: 200.0,
      totalCost: 550.0,
      workOrderProgress: {
        checklist: [
          { item: 'Check all fluid levels', completed: true, notes: 'Fluids checked.', selectedOption: 'yes' },
          { item: 'Inspect belts and hoses', completed: true, notes: 'Belts intact.', selectedOption: 'yes' },
          { item: 'Test battery and charging system', completed: true, notes: '14.1V charging.', selectedOption: 'yes' },
          { item: 'Check exterior and interior lights', completed: true, notes: 'Lights working.', selectedOption: 'yes' },
          { item: 'Inspect wiper blades', completed: true, notes: 'Wipers functional.', selectedOption: 'yes' },
        ],
      },
    },
    {
      vehicleId: vehicles[0].plateNumber, // NDG 5821
      title: brakeInspectionTemplate?.type ?? 'Brake Inspection',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-03-05T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: brakeInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 38000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 15000,
      partsCost: 620.0,
      laborCost: 310.0,
      totalCost: 930.0,
      workOrderProgress: {
        checklist: [
          { item: 'Check brake pad thickness', completed: true, notes: 'Pad thickness 8mm.', selectedOption: 'yes' },
          { item: 'Inspect brake rotors for wear', completed: true, notes: 'Rotors resurfaced.', selectedOption: 'yes' },
          { item: 'Check brake fluid level and condition', completed: true, notes: 'Brake fluid flushed.', selectedOption: 'yes' },
          { item: 'Inspect brake lines for leaks', completed: true, notes: 'Lines clean.', selectedOption: 'yes' },
          { item: 'Test brake pedal feel', completed: true, notes: 'Pedal firm.', selectedOption: 'yes' },
        ],
      },
    },
    {
      vehicleId: vehicles[1].plateNumber, // CAK 9043
      title: tireRotationTemplate?.type ?? 'Tire Rotation',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-02-18T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: tireRotationTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 58000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 10000,
      partsCost: 150.0,
      laborCost: 200.0,
      totalCost: 350.0,
      workOrderProgress: {
        checklist: [
          { item: 'Check tire pressure on all tires', completed: true, notes: 'Pressures set to 35 PSI.', selectedOption: 'yes' },
          { item: 'Inspect tire tread depth', completed: true, notes: '6mm tread remaining.', selectedOption: 'yes' },
          { item: 'Rotate tires according to pattern', completed: true, notes: 'Cross rotation completed.', selectedOption: 'yes' },
          { item: 'Torque lug nuts to specification', completed: true, notes: 'Torqued to 110 ft-lbs.', selectedOption: 'yes' },
          { item: 'Check alignment if irregular wear found', completed: true, notes: 'Alignment normal.', selectedOption: 'yes' },
        ],
      },
    },
    {
      vehicleId: vehicles[2].plateNumber, // WOB 2947
      title: oilChangeTemplate?.type ?? 'Oil Change',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-01-25T00:00:00.000Z'),
      assignedMechanic: mechanics[2].name,
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: oilChangeTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 26000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 8000,
      partsCost: 480.0,
      laborCost: 220.0,
      totalCost: 700.0,
      workOrderProgress: {
        checklist: [
          { item: 'Drain old engine oil', completed: true, notes: 'Oil drained cleanly.', selectedOption: 'yes' },
          { item: 'Replace oil filter', completed: true, notes: 'Filter replaced.', selectedOption: 'yes' },
          { item: 'Fill with new engine oil', completed: true, notes: '5.5L 10W-30 filled.', selectedOption: 'yes' },
          { item: 'Check for oil leaks', completed: true, notes: 'No leaks found.', selectedOption: 'yes' },
          { item: 'Reset maintenance light', completed: true, notes: 'Light reset.', selectedOption: 'yes' },
        ],
      },
    },
    {
      vehicleId: vehicles[3].plateNumber, // PXW 382
      title: engineTuneupTemplate?.type ?? 'Engine Tune-up',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-03-14T00:00:00.000Z'),
      assignedMechanic: mechanics[3].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: engineTuneupTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 15000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 15000,
      partsCost: 950.0,
      laborCost: 480.0,
      totalCost: 1430.0,
      workOrderProgress: {
        checklist: [
          { item: 'Replace spark plugs', completed: true, notes: 'Iridium plugs installed.', selectedOption: 'yes' },
          { item: 'Inspect ignition coils/wires', completed: true, notes: 'Coils in good condition.', selectedOption: 'yes' },
          { item: 'Replace air filter', completed: true, notes: 'OEM filter installed.', selectedOption: 'yes' },
          { item: 'Clean fuel injectors', completed: true, notes: 'Injectors cleaned.', selectedOption: 'yes' },
          { item: 'Check engine timing and idle', completed: true, notes: 'Idle stable.', selectedOption: 'yes' },
        ],
      },
    },
    {
      vehicleId: vehicles[4].plateNumber, // TGD 908
      title: brakeInspectionTemplate?.type ?? 'Brake Inspection',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-02-10T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: brakeInspectionTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 85000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 20000,
      partsCost: 780.0,
      laborCost: 390.0,
      totalCost: 1170.0,
      workOrderProgress: {
        checklist: [
          { item: 'Check brake pad thickness', completed: true, notes: 'Heavy duty pads installed.', selectedOption: 'yes' },
          { item: 'Inspect brake rotors for wear', completed: true, notes: 'Rotors turned.', selectedOption: 'yes' },
          { item: 'Check brake fluid level and condition', completed: true, notes: 'Fluid flushed DOT4.', selectedOption: 'yes' },
          { item: 'Inspect brake lines for leaks', completed: true, notes: 'No leaks.', selectedOption: 'yes' },
          { item: 'Test brake pedal feel', completed: true, notes: 'Brake test passed.', selectedOption: 'yes' },
        ],
      },
    },
    {
      vehicleId: vehicles[5].plateNumber, // NRE 471
      title: oilChangeTemplate?.type ?? 'Oil Change',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-01-10T00:00:00.000Z'),
      assignedMechanic: mechanics[4].name,
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: oilChangeTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 135000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 12000,
      partsCost: 680.0,
      laborCost: 320.0,
      totalCost: 1000.0,
      workOrderProgress: {
        checklist: [
          { item: 'Drain old engine oil', completed: true, notes: 'Oil drained.', selectedOption: 'yes' },
          { item: 'Replace oil filter', completed: true, notes: 'Filter replaced.', selectedOption: 'yes' },
          { item: 'Fill with new engine oil', completed: true, notes: '10L 15W-40 filled.', selectedOption: 'yes' },
          { item: 'Check for oil leaks', completed: true, notes: 'Checked OK.', selectedOption: 'yes' },
          { item: 'Reset maintenance light', completed: true, notes: 'Cleared.', selectedOption: 'yes' },
        ],
      },
    },
    {
      vehicleId: vehicles[0].plateNumber, // NDG 5821
      title: generalInspectionTemplate?.type ?? 'General Inspection',
      status: MaintenanceStatus.DUE,
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 46200,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.MONTHLY,
      startReferenceDate: new Date('2026-08-08T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[1].plateNumber, // CAK 9043
      title: engineTuneupTemplate?.type ?? 'Engine Tune-up',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-08-04T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: engineTuneupTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 73800,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 20000,
      bufferDistanceKm: 1000,
      startingReferenceReadingKm: 55000,
    },
    {
      vehicleId: vehicles[2].plateNumber, // WOB 2947
      title: brakeInspectionTemplate?.type ?? 'Brake Inspection',
      status: MaintenanceStatus.IN_PROGRESS,
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
      assignedMechanic: mechanics[2].name,
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: brakeInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 35200,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 15000,
      startingReferenceReadingKm: 20000,
    },
    {
      vehicleId: vehicles[3].plateNumber, // PXW 382
      title: tireRotationTemplate?.type ?? 'Tire Rotation',
      status: MaintenanceStatus.OVERDUE,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      assignedMechanic: mechanics[3].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: tireRotationTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 25100,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.QUARTERLY,
      startReferenceDate: new Date('2026-07-25T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[4].plateNumber, // TGD 908
      title: tireRotationTemplate?.type ?? 'Tire Rotation',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-08-06T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: tireRotationTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 101000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 10000,
      bufferDistanceKm: 500,
      startingReferenceReadingKm: 91000,
    },
    {
      vehicleId: vehicles[5].plateNumber, // NRE 471
      title: brakeInspectionTemplate?.type ?? 'Brake Inspection',
      status: MaintenanceStatus.DUE,
      createdAt: new Date('2026-08-04T00:00:00.000Z'),
      assignedMechanic: mechanics[4].name,
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: brakeInspectionTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 156000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 18000,
      bufferDistanceKm: 800,
      startingReferenceReadingKm: 138000,
    },
    // --- ADDITIONAL REALISTIC MAINTENANCE SCHEDULES ---
    {
      vehicleId: vehicles[0].plateNumber,
      title: 'Coolant Flush & Radiator Inspection',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-01-15T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 41000,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.SEMI_ANNUALLY,
      startReferenceDate: new Date('2026-01-15T00:00:00.000Z'),
      partsCost: 850.0,
      laborCost: 450.0,
      totalCost: 1300.0,
      workOrderProgress: {
        checklist: [
          { item: 'Flush radiator coolant', completed: true, notes: 'System flushed and refilled with OEM coolant.', selectedOption: 'yes' },
          { item: 'Inspect radiator hoses & clamps', completed: true, notes: 'Hoses intact, upper clamp tightened.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[0].plateNumber,
      title: 'Transmission Fluid & Filter Service',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-03-10T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name,
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 43000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 20000,
      startingReferenceReadingKm: 23000,
      partsCost: 1400.0,
      laborCost: 600.0,
      totalCost: 2000.0,
      workOrderProgress: {
        checklist: [
          { item: 'Drain transmission fluid', completed: true, notes: 'Fluid dark, replaced filter pan gasket.', selectedOption: 'yes' },
          { item: 'Refill fluid to spec level', completed: true, notes: 'Filled 4.5L synthetic ATF.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[0].plateNumber,
      title: 'Air & Cabin Filter Replacement',
      status: MaintenanceStatus.DUE,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      assignedMechanic: mechanics[2].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 45200,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.QUARTERLY,
      startReferenceDate: new Date('2026-08-05T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[1].plateNumber,
      title: 'Battery & Electrical System Check',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-02-18T00:00:00.000Z'),
      assignedMechanic: mechanics[3].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 68000,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.SEMI_ANNUALLY,
      startReferenceDate: new Date('2026-02-18T00:00:00.000Z'),
      partsCost: 350.0,
      laborCost: 250.0,
      totalCost: 600.0,
      workOrderProgress: {
        checklist: [
          { item: 'Test battery voltage & load', completed: true, notes: 'Passed load test at 12.6V.', selectedOption: 'yes' },
          { item: 'Clean battery terminals', completed: true, notes: 'Corrosion cleaned and anti-corrosion spray applied.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[1].plateNumber,
      title: 'Suspension & Wheel Alignment',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-05-02T00:00:00.000Z'),
      assignedMechanic: mechanics[4].name,
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 70500,
      triggerType: MaintenanceTriggerType.MANUAL,
      partsCost: 1100.0,
      laborCost: 750.0,
      totalCost: 1850.0,
      workOrderProgress: {
        checklist: [
          { item: 'Perform 4-wheel alignment', completed: true, notes: 'Camber and toe adjusted to factory specs.', selectedOption: 'yes' },
          { item: 'Inspect leaf springs and shocks', completed: true, notes: 'Rear shocks showing minor weeping, monitor next service.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[1].plateNumber,
      title: 'Exhaust System & Emissions Test',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-08-04T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 72100,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.ANNUALLY,
      startReferenceDate: new Date('2026-08-25T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[2].plateNumber,
      title: 'Differential Oil Replacement',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-01-28T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: oilChangeTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 28000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 15000,
      startingReferenceReadingKm: 13000,
      partsCost: 720.0,
      laborCost: 380.0,
      totalCost: 1100.0,
      workOrderProgress: {
        checklist: [
          { item: 'Drain differential gear oil', completed: true, notes: 'Drained gear oil, no metal shavings found.', selectedOption: 'yes' },
          { item: 'Refill 80W-90 gear oil', completed: true, notes: 'Refilled 3.2L gear oil.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[2].plateNumber,
      title: 'Fuel Filter Replacement',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-04-15T00:00:00.000Z'),
      assignedMechanic: mechanics[2].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 30000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 10000,
      startingReferenceReadingKm: 20000,
      partsCost: 480.0,
      laborCost: 220.0,
      totalCost: 700.0,
      workOrderProgress: {
        checklist: [
          { item: 'Replace primary fuel filter', completed: true, notes: 'Primary filter canister replaced and primed.', selectedOption: 'yes' },
          { item: 'Bleed fuel lines', completed: true, notes: 'Air purged, engine started smoothly.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[2].plateNumber,
      title: 'Grease Chassis & Driveshaft U-Joints',
      status: MaintenanceStatus.OVERDUE,
      createdAt: new Date('2026-07-15T00:00:00.000Z'),
      assignedMechanic: mechanics[3].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 31500,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.QUARTERLY,
      startReferenceDate: new Date('2026-07-20T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[3].plateNumber,
      title: 'Engine Valve Clearance Adjustment',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-02-05T00:00:00.000Z'),
      assignedMechanic: mechanics[4].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: engineTuneupTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 15000,
      triggerType: MaintenanceTriggerType.MANUAL,
      partsCost: 950.0,
      laborCost: 550.0,
      totalCost: 1500.0,
      workOrderProgress: {
        checklist: [
          { item: 'Check intake/exhaust valve clearance', completed: true, notes: 'Adjusted intake valves to 0.20mm cold spec.', selectedOption: 'yes' },
          { item: 'Replace valve cover gasket', completed: true, notes: 'New OEM rubber gasket fitted.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[3].plateNumber,
      title: 'Front & Rear Brake Pad Replacement',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-05-18T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name,
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: brakeInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 17200,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 15000,
      startingReferenceReadingKm: 2200,
      partsCost: 1800.0,
      laborCost: 650.0,
      totalCost: 2450.0,
      workOrderProgress: {
        checklist: [
          { item: 'Replace front ceramic brake pads', completed: true, notes: 'Installed ceramic pads, resurfaced rotors.', selectedOption: 'yes' },
          { item: 'Flush brake fluid', completed: true, notes: 'DOT 4 fluid flushed.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[3].plateNumber,
      title: 'Drive Belt & Tensioner Replacement',
      status: MaintenanceStatus.OVERDUE,
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 18000,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.SEMI_ANNUALLY,
      startReferenceDate: new Date('2026-07-15T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[4].plateNumber,
      title: 'Turbocharger & Intercooler Hose Check',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      assignedMechanic: mechanics[2].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 88000,
      triggerType: MaintenanceTriggerType.MANUAL,
      partsCost: 1250.0,
      laborCost: 650.0,
      totalCost: 1900.0,
      workOrderProgress: {
        checklist: [
          { item: 'Inspect intercooler silicone hoses', completed: true, notes: 'Replaced lower boost hose clamp.', selectedOption: 'yes' },
          { item: 'Check turbo shaft play', completed: true, notes: 'Zero axial play detected.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[4].plateNumber,
      title: 'Clutch Master & Slave Cylinder Service',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-06-05T00:00:00.000Z'),
      assignedMechanic: mechanics[3].name,
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 90500,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 25000,
      startingReferenceReadingKm: 65500,
      partsCost: 1650.0,
      laborCost: 800.0,
      totalCost: 2450.0,
      workOrderProgress: {
        checklist: [
          { item: 'Replace clutch slave cylinder', completed: true, notes: 'Replaced leaking slave cylinder.', selectedOption: 'yes' },
          { item: 'Bleed hydraulic clutch fluid', completed: true, notes: 'Hydraulic system bled, pedal pressure restored.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[4].plateNumber,
      title: 'Power Steering Pump Fluid Flush',
      status: MaintenanceStatus.DUE,
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      assignedMechanic: mechanics[4].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 92000,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.QUARTERLY,
      startReferenceDate: new Date('2026-08-08T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[5].plateNumber,
      title: 'Heavy Duty Air Brake Dryer Cartridge Service',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-01-10T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: brakeInspectionTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 138000,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.SEMI_ANNUALLY,
      startReferenceDate: new Date('2026-01-10T00:00:00.000Z'),
      partsCost: 2100.0,
      laborCost: 750.0,
      totalCost: 2850.0,
      workOrderProgress: {
        checklist: [
          { item: 'Replace air dryer desiccant cartridge', completed: true, notes: 'Desiccant cartridge replaced.', selectedOption: 'yes' },
          { item: 'Drain wet tank moisture', completed: true, notes: 'Wet tank drained, no excessive oil found.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[5].plateNumber,
      title: 'Diesel Particulate Filter (DPF) Cleaning',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-04-20T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name,
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 141000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 30000,
      startingReferenceReadingKm: 111000,
      partsCost: 3200.0,
      laborCost: 1500.0,
      totalCost: 4700.0,
      workOrderProgress: {
        checklist: [
          { item: 'Perform thermal DPF bake & flush', completed: true, notes: 'Soot load reduced from 85% to 4%.', selectedOption: 'yes' },
          { item: 'Reset DPF differential pressure sensor', completed: true, notes: 'Sensor reset via OBD scanner.', selectedOption: 'yes' }
        ]
      }
    },
    {
      vehicleId: vehicles[5].plateNumber,
      title: 'Fifth Wheel Coupling Plate Lubrication & Inspection',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
      assignedMechanic: mechanics[2].name,
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: pulilanGarage?.id,
      odometerReading: 145000,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.MONTHLY,
      startReferenceDate: new Date('2026-08-20T00:00:00.000Z'),
    },
  ].map((schedule, index) => {
    const vehicle = vehicles.find((entry) => entry.plateNumber === schedule.vehicleId);
    if (!vehicle?.garageId) throw new Error(`Cannot seed schedule for ${schedule.vehicleId}: vehicle garage assignment is missing.`);
    const chiefMechanic = chiefMechanics[index % chiefMechanics.length];
    return {
    ...schedule,
    garageId: vehicle.garageId,
    startDate: schedule.createdAt,
    chiefMechanicId: chiefMechanic.id,
    chiefMechanic: chiefMechanic.name,
    assignedMechanicId: resolveSeedMechanicId(
      schedule.assignedMechanic,
      schedule.accountType,
    ),
  }; });

  const assertCompletedScheduleHasProgress = (schedule: any) => {
    if (schedule.status === MaintenanceStatus.COMPLETED && schedule.workOrderProgress == null) {
      throw new Error(
        `Completed maintenance schedule for vehicle ${schedule.vehicleId} must include workOrderProgress in seed data.`,
      );
    }
  };

  const getNextMaintenanceDate = (date: Date, intervalType?: MaintenanceIntervalType | null) => {
    const next = new Date(date);
    switch (intervalType) {
      case MaintenanceIntervalType.DAILY:
        next.setUTCDate(next.getUTCDate() + 1);
        return next;
      case MaintenanceIntervalType.WEEKLY:
        next.setUTCDate(next.getUTCDate() + 7);
        return next;
      case MaintenanceIntervalType.MONTHLY:
        next.setUTCMonth(next.getUTCMonth() + 1);
        return next;
      case MaintenanceIntervalType.QUARTERLY:
        next.setUTCMonth(next.getUTCMonth() + 3);
        return next;
      case MaintenanceIntervalType.SEMI_ANNUALLY:
        next.setUTCMonth(next.getUTCMonth() + 6);
        return next;
      case MaintenanceIntervalType.ANNUALLY:
        next.setUTCFullYear(next.getUTCFullYear() + 1);
        return next;
      default:
        return null;
    }
  };

  // Match the partial index's LOWER(BTRIM(...)) identity. Reserve explicit
  // Pending fixtures up front so generated cycles cannot collide with later rows.
  const pendingScheduleKey = (schedule: { vehicleId: string; title: string }) =>
    JSON.stringify([schedule.vehicleId, schedule.title].map(value => value.replace(/^ +| +$/g, '').toLowerCase()));
  const pendingScheduleKeys = new Set(
    maintenanceSchedulesData
      .filter(schedule => schedule.status === MaintenanceStatus.PENDING)
      .map(pendingScheduleKey),
  );

  let recurringIdx = 0;
  const createNextSeedMaintenanceSchedule = async (completedSchedule: any) => {
    const triggerType = completedSchedule.triggerType;
    const isOdometerRecurring = triggerType === MaintenanceTriggerType.ODOMETER && completedSchedule.intervalKm != null && completedSchedule.intervalKm > 0;
    const isTimeRecurring = triggerType === MaintenanceTriggerType.TIME && Boolean(completedSchedule.intervalType);

    if (!isOdometerRecurring && !isTimeRecurring) return null;

    const nextDate = getNextMaintenanceDate((completedSchedule.startReferenceDate ?? completedSchedule.createdAt), completedSchedule.intervalType) ?? (completedSchedule.startReferenceDate ?? completedSchedule.createdAt);
    const nextOdometer = completedSchedule.odometerReading != null && completedSchedule.intervalKm != null
      ? completedSchedule.odometerReading + completedSchedule.intervalKm
      : completedSchedule.odometerReading;

    recurringIdx += 1;
    let seedStatus: MaintenanceStatus = MaintenanceStatus.PENDING;
    if (recurringIdx <= 2) {
      seedStatus = MaintenanceStatus.OVERDUE;
    } else if (recurringIdx <= 4) {
      seedStatus = MaintenanceStatus.DUE;
    }

    const pendingKey = pendingScheduleKey(completedSchedule);
    if (seedStatus === MaintenanceStatus.PENDING && pendingScheduleKeys.has(pendingKey)) {
      return null;
    }

    const nextSchedule = await prisma.maintenanceSchedule.create({
      data: {
        vehicleId: completedSchedule.vehicleId,
        startDate: nextDate,
        title: completedSchedule.title,
        status: seedStatus,
        assignedMechanic: completedSchedule.assignedMechanic,
        assignedMechanicId: completedSchedule.assignedMechanicId,
        chiefMechanicId: completedSchedule.chiefMechanicId,
        chiefMechanic: completedSchedule.chiefMechanic,
        accountType: completedSchedule.accountType,
        checklistTemplateId: completedSchedule.checklistTemplateId,
        garageId: completedSchedule.garageId,
        odometerReading: nextOdometer,
        triggerType: completedSchedule.triggerType,
        intervalKm: completedSchedule.intervalKm,
        bufferDistanceKm: completedSchedule.bufferDistanceKm,
        startingReferenceReadingKm: completedSchedule.odometerReading,
        intervalType: completedSchedule.intervalType,
        startReferenceDate: nextDate,
        previousScheduleId: completedSchedule.id,
      },
    });
    if (seedStatus === MaintenanceStatus.PENDING) pendingScheduleKeys.add(pendingKey);
    return nextSchedule;
  };

  let createdMaintenanceSchedulesCount = 0;
  for (const schedule of maintenanceSchedulesData) {
    assertCompletedScheduleHasProgress(schedule);


    const persistedSchedule = { ...schedule, ...stateForStorage((schedule.workOrderProgress ?? {}) as Record<string, any>, schedule.status) };
    const createdSchedule = await prisma.maintenanceSchedule.create({
      data: schedule.status === MaintenanceStatus.COMPLETED
        ? { ...persistedSchedule, completedAt: schedule.createdAt }
        : persistedSchedule,
    });
    createdMaintenanceSchedulesCount += 1;

    if (createdSchedule.status === MaintenanceStatus.COMPLETED) {
      const nextSchedule = await createNextSeedMaintenanceSchedule(createdSchedule);
      if (nextSchedule) createdMaintenanceSchedulesCount += 1;
    }
  }

  console.log(`  Created ${createdMaintenanceSchedulesCount} sample maintenance schedules for VMMS\n`);
}
