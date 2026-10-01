import { PrismaClient, WorkOrderStatus } from '@prisma/client';

export async function seedWorkOrders(prisma: PrismaClient) {
  console.log('Creating sample VMMS work orders...');

  // Fetch needed relations from DB
  const garages = await prisma.garage.findMany();
  const vehicles = await prisma.vehicle.findMany();
  
  const vmmsAdminUser = await prisma.user.findFirstOrThrow({
    where: { email: 'vmms.admin@welinc.com' }
  });
  const opsUser = await prisma.user.findFirstOrThrow({
    where: { email: 'ops.user@welinc.com' }
  });
  
  const mechanics = await prisma.mechanic.findMany({
    where: {
      user: {
        roles: {
          some: {
            role: 'MECHANIC',
            system: 'VMMS'
          }
        }
      }
    },
    include: { user: { select: { email: true } } },
  });

  const adminUser = { id: vmmsAdminUser.id, email: vmmsAdminUser.email };

  // Manual 10 work orders
  const workOrder1 = await prisma.workOrder.upsert({
    where: { workOrderNumber: 'WO-20260610-0001' },
    update: {},
    create: {
      workOrderNumber: 'WO-20260610-0001',
      status: WorkOrderStatus.PENDING,
      vehicleId: vehicles[0].id,
      garageId: garages[0].id,
      odometer: 45200,
      remarks: 'Truck transmission slips occasionally when shifting to second gear.',
      issues: {
        create: [
          { description: '[Transmission] Wear and tear: Transmission slipping intermittently' }
        ]
      },
      targetDueDate: new Date('2026-06-25T17:00:00Z'),
      createdAt: new Date('2026-06-10T08:00:00.000Z'),
      auditLogs: {
        create: [
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'CREATE',
            newValue: 'PENDING',
            createdAt: new Date('2026-06-10T08:00:00.000Z'),
          }
        ]
      }
    }
  });

  const workOrder2 = await prisma.workOrder.upsert({
    where: { workOrderNumber: 'WO-20260612-0002' },
    update: {},
    create: {
      workOrderNumber: 'WO-20260612-0002',
      status: WorkOrderStatus.IN_PROGRESS,
      vehicleId: vehicles[1].id,
      garageId: garages[1].id,
      odometer: 72500,
      remarks: 'Squealing sound from brakes when loaded.',
      issues: {
        create: [
          { description: '[Brakes] Wear and tear: Brake pads squealing' },
          { description: '[Brakes] Wear and tear: Worn front rotor discs' }
        ]
      },
      mechanics: {
        connect: [{ id: mechanics[0].id }]
      },
      targetDueDate: new Date('2026-06-24T12:00:00Z'),
      createdAt: new Date('2026-06-12T08:00:00.000Z'),
      auditLogs: {
        create: [
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'CREATE',
            newValue: 'PENDING',
            createdAt: new Date('2026-06-12T08:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'PENDING',
            newValue: 'IN_PROGRESS',
            createdAt: new Date('2026-06-12T09:30:00.000Z'),
          }
        ]
      }
    }
  });

  const workOrder3 = await prisma.workOrder.upsert({
    where: { workOrderNumber: 'WO-20260614-0003' },
    update: {},
    create: {
      workOrderNumber: 'WO-20260614-0003',
      status: WorkOrderStatus.FOR_VERIFICATION,
      vehicleId: vehicles[2].id,
      garageId: garages[2].id,
      odometer: 32000,
      remarks: 'Scheduled PMS: Engine oil, air filter, and fuel filter replacement.',
      issues: {
        create: [
          { description: '[Engine] Wear and tear: Engine oil change' },
          { description: '[Engine] Wear and tear: Replace air and fuel filters' }
        ]
      },
      mechanics: {
        connect: [{ id: mechanics[1].id }]
      },
      partsCost: 3500.00,
      laborCost: 1500.00,
      totalCost: 5000.00,
      repairParts: {
        create: [
          { description: 'Fully Synthetic Engine Oil', unitCost: 600.00, quantity: 4, subtotal: 2400.00 },
          { description: 'Air Filter', unitCost: 500.00, quantity: 1, subtotal: 500.00 },
          { description: 'Fuel Filter', unitCost: 600.00, quantity: 1, subtotal: 600.00 }
        ]
      },
      targetDueDate: new Date('2026-06-23T15:00:00Z'),
      createdAt: new Date('2026-06-14T08:00:00.000Z'),
      auditLogs: {
        create: [
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'CREATE',
            newValue: 'PENDING',
            createdAt: new Date('2026-06-14T08:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'PENDING',
            newValue: 'IN_PROGRESS',
            createdAt: new Date('2026-06-14T09:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'COST_UPDATE',
            newValue: '5000.00',
            createdAt: new Date('2026-06-14T11:00:00.000Z'),
          },
          {
            userId: mechanics[1].userId!,
            email: `mech.${mechanics[1].name.split(' ')[0].toLowerCase()}@welinc.com`,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'IN_PROGRESS',
            newValue: 'FOR_VERIFICATION',
            createdAt: new Date('2026-06-14T16:00:00.000Z'),
          }
        ]
      }
    }
  });

  const workOrder4 = await prisma.workOrder.upsert({
    where: { workOrderNumber: 'WO-20260611-0004' },
    update: {},
    create: {
      workOrderNumber: 'WO-20260611-0004',
      status: WorkOrderStatus.COMPLETED,
      vehicleId: vehicles[0].id,
      garageId: garages[0].id,
      odometer: 44900,
      remarks: 'Replace front passenger side tire due to puncture.',
      issues: {
        create: [
          { description: '[Brakes] Impact damage: Punctured front passenger tire' }
        ]
      },
      mechanics: {
        connect: [{ id: mechanics[0].id }]
      },
      partsCost: 4500.00,
      laborCost: 800.00,
      totalCost: 5300.00,
      repairParts: {
        create: [
          { description: 'Bridgestone Truck Tire 10.00R20', unitCost: 4500.00, quantity: 1, subtotal: 4500.00 }
        ]
      },
      completedAt: new Date('2026-06-12T16:30:00Z'),
      createdAt: new Date('2026-06-11T09:00:00.000Z'),
      auditLogs: {
        create: [
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'CREATE',
            newValue: 'PENDING',
            createdAt: new Date('2026-06-11T09:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'PENDING',
            newValue: 'IN_PROGRESS',
            createdAt: new Date('2026-06-11T10:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'IN_PROGRESS',
            newValue: 'FOR_VERIFICATION',
            createdAt: new Date('2026-06-12T11:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'COST_UPDATE',
            newValue: '5300.00',
            createdAt: new Date('2026-06-12T13:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'FOR_VERIFICATION',
            newValue: 'COMPLETED',
            createdAt: new Date('2026-06-12T16:30:00.000Z'),
          }
        ]
      }
    }
  });

  const workOrder5 = await prisma.workOrder.upsert({
    where: { workOrderNumber: 'WO-20260613-0005' },
    update: {},
    create: {
      workOrderNumber: 'WO-20260613-0005',
      status: WorkOrderStatus.COMPLETED,
      vehicleId: vehicles[4].id,
      garageId: garages[1].id,
      odometer: 92200,
      remarks: 'Blown head gasket replacement. Engine overheating.',
      issues: {
        create: [
          { description: '[Engine] Overheating: Blown head gasket replaced' }
        ]
      },
      mechanics: {
        connect: [{ id: mechanics[0].id }]
      },
      partsCost: 12000.00,
      laborCost: 3000.00,
      totalCost: 15000.00,
      repairParts: {
        create: [
          { description: 'Cylinder Head Gasket', unitCost: 4500.00, quantity: 1, subtotal: 4500.00 },
          { description: 'Engine Coolant', unitCost: 500.00, quantity: 3, subtotal: 1500.00 },
          { description: 'Engine Valves Set', unitCost: 6000.00, quantity: 1, subtotal: 6000.00 }
        ]
      },
      completedAt: new Date('2026-06-15T15:00:00Z'),
      createdAt: new Date('2026-06-13T09:00:00.000Z'),
      auditLogs: {
        create: [
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'CREATE',
            newValue: 'PENDING',
            createdAt: new Date('2026-06-13T09:00:00.000Z'),
          },
          {
            userId: mechanics[0].userId!,
            email: `mech.${mechanics[0].name.split(' ')[0].toLowerCase()}@welinc.com`,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'PENDING',
            newValue: 'IN_PROGRESS',
            createdAt: new Date('2026-06-13T10:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'COST_UPDATE',
            newValue: '15000.00',
            createdAt: new Date('2026-06-15T10:00:00.000Z'),
          },
          {
            userId: mechanics[0].userId!,
            email: `mech.${mechanics[0].name.split(' ')[0].toLowerCase()}@welinc.com`,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'IN_PROGRESS',
            newValue: 'FOR_VERIFICATION',
            createdAt: new Date('2026-06-15T12:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'FOR_VERIFICATION',
            newValue: 'COMPLETED',
            createdAt: new Date('2026-06-15T15:00:00.000Z'),
          }
        ]
      }
    }
  });

  const workOrder6 = await prisma.workOrder.upsert({
    where: { workOrderNumber: 'WO-20260614-0006' },
    update: {},
    create: {
      workOrderNumber: 'WO-20260614-0006',
      status: WorkOrderStatus.CANCELLED,
      vehicleId: vehicles[0].id,
      garageId: garages[0].id,
      odometer: 45400,
      remarks: 'Intermittent starter issue reported during vehicle inspection.',
      issues: {
        create: [
          { description: '[Electrical] Electrical fault: Starter motor intermittent fault' }
        ]
      },
      cancellationReason: 'Client requested to defer repair until next scheduled PMS.',
      completedAt: new Date('2026-06-14T17:30:00Z'),
      createdAt: new Date('2026-06-14T14:00:00.000Z'),
      auditLogs: {
        create: [
          {
            userId: opsUser.id,
            email: opsUser.email,
            action: 'CREATE',
            newValue: 'PENDING',
            createdAt: new Date('2026-06-14T14:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'PENDING',
            newValue: 'CANCELLED',
            createdAt: new Date('2026-06-14T17:30:00.000Z'),
          }
        ]
      }
    }
  });

  const workOrder7 = await prisma.workOrder.upsert({
    where: { workOrderNumber: 'WO-20260615-0007' },
    update: {},
    create: {
      workOrderNumber: 'WO-20260615-0007',
      status: WorkOrderStatus.PENDING,
      vehicleId: vehicles[5].id,
      garageId: garages[2].id,
      odometer: 145100,
      remarks: 'Rough clutch engagement reported during vehicle inspection.',
      issues: {
        create: [
          { description: '[Transmission] Wear and tear: Rough clutch engagement' }
        ]
      },
      targetDueDate: new Date('2026-06-28T17:00:00Z'),
      createdAt: new Date('2026-06-15T08:00:00.000Z'),
      auditLogs: {
        create: [
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'CREATE',
            newValue: 'PENDING',
            createdAt: new Date('2026-06-15T08:00:00.000Z'),
          }
        ]
      }
    }
  });

  const workOrder8 = await prisma.workOrder.upsert({
    where: { workOrderNumber: 'WO-20260615-0008' },
    update: {},
    create: {
      workOrderNumber: 'WO-20260615-0008',
      status: WorkOrderStatus.IN_PROGRESS,
      vehicleId: vehicles[1].id,
      garageId: garages[1].id,
      odometer: 72800,
      remarks: 'Rear suspension squeak when loaded.',
      issues: {
        create: [
          { description: '[Suspension] Wear and tear: Leaking rear shock absorber' }
        ]
      },
      mechanics: {
        connect: [{ id: mechanics[1].id }]
      },
      targetDueDate: new Date('2026-06-25T17:00:00Z'),
      createdAt: new Date('2026-06-15T08:00:00.000Z'),
      auditLogs: {
        create: [
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'CREATE',
            newValue: 'PENDING',
            createdAt: new Date('2026-06-15T08:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'PENDING',
            newValue: 'IN_PROGRESS',
            createdAt: new Date('2026-06-15T10:00:00.000Z'),
          }
        ]
      }
    }
  });

  const workOrder9 = await prisma.workOrder.upsert({
    where: { workOrderNumber: 'WO-20260615-0009' },
    update: {},
    create: {
      workOrderNumber: 'WO-20260615-0009',
      status: WorkOrderStatus.FOR_VERIFICATION,
      vehicleId: vehicles[2].id,
      garageId: garages[0].id,
      odometer: 32100,
      remarks: 'Overheating under heavy load. Thermostat stuck.',
      issues: {
        create: [
          { description: '[Cooling] Overheating: Thermostat stuck closed' }
        ]
      },
      mechanics: {
        connect: [{ id: mechanics[1].id }]
      },
      partsCost: 1500.00,
      laborCost: 800.00,
      totalCost: 2300.00,
      repairParts: {
        create: [
          { description: 'Replacement Thermostat', unitCost: 1200.00, quantity: 1, subtotal: 1200.00 },
          { description: 'Thermostat Gasket', unitCost: 300.00, quantity: 1, subtotal: 300.00 }
        ]
      },
      targetDueDate: new Date('2026-06-22T12:00:00Z'),
      createdAt: new Date('2026-06-15T09:00:00.000Z'),
      auditLogs: {
        create: [
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'CREATE',
            newValue: 'PENDING',
            createdAt: new Date('2026-06-15T09:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'PENDING',
            newValue: 'IN_PROGRESS',
            createdAt: new Date('2026-06-15T11:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'COST_UPDATE',
            newValue: '2300.00',
            createdAt: new Date('2026-06-15T13:00:00.000Z'),
          },
          {
            userId: mechanics[1].userId!,
            email: `mech.${mechanics[1].name.split(' ')[0].toLowerCase()}@welinc.com`,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'IN_PROGRESS',
            newValue: 'FOR_VERIFICATION',
            createdAt: new Date('2026-06-15T16:00:00.000Z'),
          }
        ]
      }
    }
  });

  const workOrder10 = await prisma.workOrder.upsert({
    where: { workOrderNumber: 'WO-20260614-0010' },
    update: {},
    create: {
      workOrderNumber: 'WO-20260614-0010',
      status: WorkOrderStatus.COMPLETED,
      vehicleId: vehicles[3].id,
      garageId: garages[0].id,
      odometer: 18500,
      remarks: 'Battery replacement completed.',
      issues: {
        create: [
          { description: '[Electrical] Wear and tear: Replace worn battery' }
        ]
      },
      mechanics: {
        connect: [{ id: mechanics[0].id }]
      },
      partsCost: 5500.00,
      laborCost: 500.00,
      totalCost: 6000.00,
      repairParts: {
        create: [
          { description: 'Motolite Gold Maintenance Free Battery', unitCost: 5500.00, quantity: 1, subtotal: 5500.00 }
        ]
      },
      isUnlocked: true,
      unlockReason: 'Correcting battery serial number error',
      completedAt: new Date('2026-06-14T15:00:00Z'),
      createdAt: new Date('2026-06-14T09:00:00.000Z'),
      auditLogs: {
        create: [
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'CREATE',
            newValue: 'PENDING',
            createdAt: new Date('2026-06-14T09:00:00.000Z'),
          },
          {
            userId: mechanics[0].userId!,
            email: `mech.${mechanics[0].name.split(' ')[0].toLowerCase()}@welinc.com`,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'PENDING',
            newValue: 'IN_PROGRESS',
            createdAt: new Date('2026-06-14T10:00:00.000Z'),
          },
          {
            userId: mechanics[0].userId!,
            email: `mech.${mechanics[0].name.split(' ')[0].toLowerCase()}@welinc.com`,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'IN_PROGRESS',
            newValue: 'FOR_VERIFICATION',
            createdAt: new Date('2026-06-14T12:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'COST_UPDATE',
            newValue: '6000.00',
            createdAt: new Date('2026-06-14T13:30:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'STATUS_CHANGE',
            fieldName: 'status',
            previousValue: 'FOR_VERIFICATION',
            newValue: 'COMPLETED',
            createdAt: new Date('2026-06-14T15:00:00.000Z'),
          },
          {
            userId: adminUser.id,
            email: adminUser.email,
            action: 'UNLOCK',
            newValue: 'Correcting battery serial number error',
            createdAt: new Date('2026-06-14T16:00:00.000Z'),
          }
        ]
      }
    }
  });

  console.log('  Created 10 sample work orders with full histories and audit logs for VMMS\n');

  // Bulk seeding for pagination (80 work orders)
  console.log('Generating 80 additional work orders with realistic real-world details...');
  const statuses = [
    WorkOrderStatus.PENDING,
    WorkOrderStatus.IN_PROGRESS,
    WorkOrderStatus.FOR_VERIFICATION,
    WorkOrderStatus.COMPLETED,
    WorkOrderStatus.CANCELLED,
  ];

  const categories = ['Engine', 'Brakes', 'Transmission', 'Suspension', 'Electrical', 'Cooling'];
  
  const realIssues: Record<string, Array<{ desc: string; remarks: string; part: string; baseCost: number }>> = {
    Engine: [
      { desc: 'Engine misfire code P0301', remarks: 'Engine cylinders 2 and 3 misfiring. Replaced ignition coil packs and spark plugs.', part: 'Bosch Spark Plugs Set', baseCost: 1500 },
      { desc: 'Rough idle on cold start', remarks: 'Replaced worn serpentine belt and tensioner pulley to eliminate cold start belt squeal.', part: 'Serpentine Belt & Tensioner', baseCost: 2500 },
      { desc: 'Oil pressure warning light on', remarks: 'Replaced oil pump assembly and flushed oil system to resolve low oil pressure warning.', part: 'Oil Pump Assembly', baseCost: 8000 },
      { desc: 'Loss of power under load', remarks: 'Cleaned throttle body, replaced air filter and fuel filter to restore engine output.', part: 'Fuel Filter and Air Filter Kit', baseCost: 1800 },
    ],
    Brakes: [
      { desc: 'Squealing noise from front wheels', remarks: 'Brake pads worn down to indicators. Installed new ceramic brake pads and resurfaced front rotors.', part: 'Ceramic Brake Pads (Front)', baseCost: 2200 },
      { desc: 'Soft brake pedal feel', remarks: 'Brake master cylinder leaking fluid. Installed replacement master cylinder and bled entire system.', part: 'Brake Master Cylinder', baseCost: 4500 },
      { desc: 'Vibration in steering wheel when braking', remarks: 'Warped front rotors. Replaced front brake rotors and brake pads.', part: 'Brake Rotors (Pair) & Pad Set', baseCost: 5500 },
    ],
    Transmission: [
      { desc: 'Clutch slipping on acceleration', remarks: 'Clutch disc worn out. Replaced clutch disc, pressure plate, release bearing, and resurfaced flywheel.', part: 'LUK Clutch Kit', baseCost: 9500 },
      { desc: 'Transmission fluid leak from cooler line', remarks: 'Transmission oil cooler line leaking. Replaced cooler lines and topped off ATF.', part: 'Transmission Cooler Line Hose', baseCost: 1800 },
      { desc: 'Hard shifting from 1st to 2nd', remarks: 'Solenoid valve body faulty. Replaced shift solenoids and transmission filter.', part: 'Shift Solenoid Pack', baseCost: 6500 },
    ],
    Suspension: [
      { desc: 'Clunking noise over bumps', remarks: 'Front strut assemblies leaking oil. Installed new strut assemblies and performed wheel alignment.', part: 'Front Strut Assemblies (Pair)', baseCost: 7500 },
      { desc: 'Vehicle pulling to the left', remarks: 'Lower control arm bushings torn. Replaced lower control arms and ball joints.', part: 'Lower Control Arm', baseCost: 3200 },
      { desc: 'Uneven tire wear and tracking issues', remarks: 'Tie rod ends loose. Replaced outer tie rod ends and adjusted steering rack tracking.', part: 'Outer Tie Rod End Set', baseCost: 2000 },
    ],
    Electrical: [
      { desc: 'Alternator not charging battery', remarks: 'Alternator failing to output charge. Installed replacement 90A alternator and checked battery health.', part: 'Denso Alternator 90A', baseCost: 6000 },
      { desc: 'Starter motor clicks but does not crank', remarks: 'Starter solenoid burnt. Replaced complete starter motor assembly.', part: 'Starter Motor Assembly', baseCost: 4000 },
      { desc: 'Headlights dim and dashboard flickering', remarks: 'Corroded battery terminals and main ground cable. Cleaned contacts and replaced cable terminal clamps.', part: 'Terminal Clamp Set & Ground Cable', baseCost: 1200 },
    ],
    Cooling: [
      { desc: 'Radiator leak from plastic tank seam', remarks: 'Radiator core cracked. Installed replacement aluminum radiator and new radiator cap.', part: 'Aluminum Radiator', baseCost: 5000 },
      { desc: 'Engine overheating at idle', remarks: 'Thermostat stuck closed causing coolant block. Replaced thermostat and flushed system.', part: 'Thermostat 82C', baseCost: 1500 },
      { desc: 'Water pump bearing noise and leak', remarks: 'Water pump bearing worn and leaking coolant. Replaced water pump and bypass hose.', part: 'Water Pump Assembly', baseCost: 3800 },
    ],
  };

  const allMechanics = await prisma.mechanic.findMany({
    include: { user: true }
  });

  for (let i = 1; i <= 80; i++) {
    // Spreads work orders over the last 80 days
    const workOrderBaseDate = new Date('2026-06-20T08:00:00.000Z');
    workOrderBaseDate.setUTCDate(workOrderBaseDate.getUTCDate() - (80 - i));

    const createdTime = workOrderBaseDate;
    const inProgressTime = new Date(createdTime.getTime() + 2 * 60 * 60 * 1000);
    const forVerificationTime = new Date(createdTime.getTime() + 6 * 60 * 60 * 1000);
    const completedTime = new Date(createdTime.getTime() + 8 * 60 * 60 * 1000);

    const year = createdTime.getUTCFullYear();
    const month = String(createdTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(createdTime.getUTCDate()).padStart(2, '0');
    const workOrderNumber = `WO-${year}${month}${day}-${String(i).padStart(4, '0')}`;

    const status = statuses[i % statuses.length];
    const vehicle = vehicles[i % vehicles.length];
    const garage = garages[i % garages.length];
    const mechanic = allMechanics[i % allMechanics.length];
    
    const cat = categories[i % categories.length];
    const templates = realIssues[cat];
    const template = templates[i % templates.length];
    
    const desc = `[${cat}] Diagnostic: ${template.desc}`;
    const remarks = template.remarks;

    const isClosed = status === WorkOrderStatus.COMPLETED || status === WorkOrderStatus.CANCELLED;
    const completedAt = isClosed ? completedTime : null;
    const cancellationReason = status === WorkOrderStatus.CANCELLED ? 'Deferred repair to next scheduled PMS interval.' : null;

    const partsCost = isClosed ? template.baseCost : null;
    const laborCost = isClosed ? Math.round(template.baseCost * 0.3) : null;
    const totalCost = isClosed ? (partsCost! + laborCost!) : null;

    await prisma.workOrder.upsert({
      where: { workOrderNumber },
      update: {},
      create: {
        workOrderNumber,
        status: status,
        vehicleId: vehicle.id,
        garageId: garage.id,
        odometer: vehicle.odometer + 100 + i,
        remarks: `Vehicle reported with ${template.desc.toLowerCase()}. Remarks: ${remarks}`,
        issues: {
          create: [{ description: desc }]
        },
        mechanics: status !== WorkOrderStatus.PENDING ? {
          connect: [{ id: mechanic.id }]
        } : undefined,
        partsCost,
        laborCost,
        totalCost,
        cancellationReason,
        completedAt,
        createdAt: createdTime,
        repairParts: isClosed ? {
          create: [
            {
              description: template.part,
              unitCost: template.baseCost,
              quantity: 1,
              subtotal: template.baseCost,
            }
          ]
        } : undefined,
        auditLogs: {
          create: [
            {
              userId: vmmsAdminUser.id,
              email: vmmsAdminUser.email,
              action: 'CREATE',
              newValue: 'PENDING',
              createdAt: createdTime,
            },
            ...(status !== WorkOrderStatus.PENDING ? [
              {
                userId: vmmsAdminUser.id,
                email: vmmsAdminUser.email,
                action: 'STATUS_CHANGE',
                fieldName: 'status',
                previousValue: 'PENDING',
                newValue: 'IN_PROGRESS',
                createdAt: inProgressTime,
              }
            ] : []),
            ...(status === WorkOrderStatus.FOR_VERIFICATION || isClosed ? [
              {
                userId: mechanic.userId!,
                email: mechanic.user!.email,
                action: 'STATUS_CHANGE',
                fieldName: 'status',
                previousValue: 'IN_PROGRESS',
                newValue: 'FOR_VERIFICATION',
                createdAt: forVerificationTime,
              }
            ] : []),
            ...(isClosed ? [
              {
                userId: vmmsAdminUser.id,
                email: vmmsAdminUser.email,
                action: 'STATUS_CHANGE',
                fieldName: 'status',
                previousValue: 'FOR_VERIFICATION',
                newValue: status,
                createdAt: completedTime,
              }
            ] : [])
          ]
        }
      }
    });
  }
  console.log('  Seeded 80 additional work orders with realistic names, remarks, and audit logs.\n');
}
