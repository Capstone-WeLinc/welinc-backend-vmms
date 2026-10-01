import { PrismaClient, UserRole, SystemType } from '@prisma/client';
import * as argon2 from 'argon2';

export async function seedUsers(prisma: PrismaClient) {
  console.log('Creating partitioned admin users...');

  const adminPasswordHash = await argon2.hash('admin1234');

  // VMMS Admin
  const vmmsAdminUser = await prisma.user.upsert({
    where: { email: 'vmms.admin@welinc.com' },
    update: { emailVerified: true },
    create: {
      name: 'Valerio Mercado',
      email: 'vmms.admin@welinc.com',
      emailVerified: true,
      passwordHash: adminPasswordHash,
    },
  });

  await prisma.userRoleAssignment.upsert({
    where: {
      userId_role_system: {
        userId: vmmsAdminUser.id,
        role: UserRole.ADMIN,
        system: SystemType.VMMS,
      },
    },
    update: {},
    create: {
      userId: vmmsAdminUser.id,
      role: UserRole.ADMIN,
      system: SystemType.VMMS,
    },
  });

  console.log('  VMMS admin user created');

  // VMMS Operations and mechanic users
  console.log('Creating VMMS Operations and mechanic users...');
  const opsPasswordHash = await argon2.hash('ops1234');
  const chiefMechanicPasswordHash = await argon2.hash('chiefmech1234');

  const opsUser = await prisma.user.upsert({
    where: { email: 'ops.user@welinc.com' },
    update: { emailVerified: true },
    create: {
      name: 'Oscar Ramos',
      email: 'ops.user@welinc.com',
      emailVerified: true,
      passwordHash: opsPasswordHash,
    },
  });

  for (const sys of [SystemType.VMMS]) {
    await prisma.userRoleAssignment.upsert({
      where: {
        userId_role_system: {
          userId: opsUser.id,
          role: UserRole.OPERATIONS,
          system: sys,
        },
      },
      update: {},
      create: {
        userId: opsUser.id,
        role: UserRole.OPERATIONS,
        system: sys,
      },
    });
  }

  // 5. Chief Mechanic
  console.log('Creating Chief Mechanic user...');

  const vmmsChiefMechanics = [
    { email: 'vmms.chiefmech@welinc.com', name: 'Ramon Garcia' },
    { email: 'vmms.chiefmech2@welinc.com', name: 'Diego Martinez' },
  ];

  for (const chief of vmmsChiefMechanics) {
    const user = await prisma.user.upsert({
      where: { email: chief.email },
      update: { emailVerified: true },
      create: {
        name: chief.name,
        email: chief.email,
        emailVerified: true,
        passwordHash: chiefMechanicPasswordHash,
      },
    });

    await prisma.userRoleAssignment.upsert({
      where: {
        userId_role_system: {
          userId: user.id,
          role: UserRole.CHIEF_MECHANIC,
          system: SystemType.VMMS,
        },
      },
      update: {},
      create: {
        userId: user.id,
        role: UserRole.CHIEF_MECHANIC,
        system: SystemType.VMMS,
      },
    });

    console.log(
      `  VMMS Chief Mechanic user created: email: ${chief.email} password: chiefmech1234`,
    );
  }

  // 6. Mechanics
  console.log('Creating sample mechanics...');
  const mechanicPassword = await argon2.hash('mechanic1234');
  const mechEmails = [
    { email: 'mech.juan@welinc.com', name: 'Juan dela Cruz' },
    { email: 'mech.pedro@welinc.com', name: 'Pedro Santos' },
    { email: 'mech.rommel@welinc.com', name: 'Rommel Cruz' },
    { email: 'mech.isabel@welinc.com', name: 'Isabel Reyes' },
    { email: 'mech.carl@welinc.com', name: 'Carl Santos' },
  ];

  for (const m of mechEmails) {
    const user = await prisma.user.upsert({
      where: { email: m.email },
      update: { emailVerified: true },
      create: {
        name: m.name,
        email: m.email,
        emailVerified: true,
        passwordHash: mechanicPassword,
      },
    });

    for (const sys of [SystemType.VMMS]) {
      await prisma.userRoleAssignment.upsert({
        where: {
          userId_role_system: {
            userId: user.id,
            role: UserRole.MECHANIC,
            system: sys,
          },
        },
        update: {},
        create: {
          userId: user.id,
          role: UserRole.MECHANIC,
          system: sys,
        },
      });
    }

    await prisma.mechanic.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        name: user.name,
        isOutsourced: false,
      },
    });
  }

  // 6. Bulk seeding for pagination (60 users)
  console.log(
    'Generating 60 additional mechanics/users with realistic names...',
  );
  const firstNames = [
    'Danilo',
    'Edgardo',
    'Ramon',
    'Arnel',
    'Bernardo',
    'Catalino',
    'Dionisio',
    'Juan',
    'Pedro',
    'Rommel',
    'Roberto',
    'Generoso',
    'Jaime',
    'Manuel',
    'Restituto',
    'Reynaldo',
    'Salvador',
    'Vicente',
    'Wilfredo',
    'Renato',
    'Gregorio',
    'Leopoldo',
    'Rolando',
    'Armando',
    'Francisco',
    'Ernesto',
    'Fernando',
    'Mario',
    'Antonio',
    'Joseph',
    'Alberto',
    'Ricardo',
    'Ferdinand',
    'Eduardo',
    'Roger',
    'Enrique',
    'Luis',
    'Carlos',
    'Oscar',
    'Winston',
    'Benjamin',
  ];
  const lastNames = [
    'Santos',
    'Ramos',
    'Cruz',
    'Gonzales',
    'Reyes',
    'Castro',
    'Bulaon',
    'Mendoza',
    'Pascual',
    'Perez',
    'Mercado',
    'Dizon',
    'Aquino',
    'Bautista',
    'Garcia',
    'Torres',
    'Tolentino',
    'Villanueva',
    'dela Cruz',
    'Ocampo',
    'Espiritu',
    'Panganiban',
    'Soriano',
    'Gomez',
    'Lopez',
    'Castillo',
    'Santiago',
    'Sebastian',
    'del Rosario',
    'Valdez',
    'Guzman',
    'Corpuz',
  ];

  for (let i = 1; i <= 60; i++) {
    const firstName = firstNames[i % firstNames.length];
    const lastName = lastNames[(i * 3) % lastNames.length];
    const name = `${firstName} ${lastName}`;
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase().replace(/\s+/g, '')}${i}@welinc.com`;

    const user = await prisma.user.upsert({
      where: { email },
      update: { emailVerified: true },
      create: {
        name,
        email,
        emailVerified: true,
        passwordHash: mechanicPassword,
      },
    });

    for (const sys of [SystemType.VMMS]) {
      await prisma.userRoleAssignment.upsert({
        where: {
          userId_role_system: {
            userId: user.id,
            role: UserRole.MECHANIC,
            system: sys,
          },
        },
        update: {},
        create: {
          userId: user.id,
          role: UserRole.MECHANIC,
          system: sys,
        },
      });
    }

    await prisma.mechanic.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        name: user.name,
        isOutsourced: i % 5 === 0,
      },
    });
  }

  console.log('  All seed users and mechanics successfully processed.\n');
}
