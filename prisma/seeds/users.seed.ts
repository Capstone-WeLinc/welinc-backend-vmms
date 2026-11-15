import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

type SeedPerson = { id: string; email: string; name: string; state: string; roles: { system: string; role: string }[] };
type SeedFile = { people: SeedPerson[] };

export function suiteSeedPeople(): SeedPerson[] {
  const path = join(process.cwd(), 'prisma', 'seeds', 'people.json');
  return (JSON.parse(readFileSync(path, 'utf8')) as SeedFile).people;
}

export async function seedUsers(prisma: PrismaClient) {
  const people = suiteSeedPeople();
  for (const person of people) {
    const vmmsRoles = person.roles.filter((assignment) => assignment.system === 'VMMS').map((assignment) => assignment.role);
    await prisma.vmmsPerson.upsert({
      where: { authUserId: person.id },
      create: { authUserId: person.id, name: person.name, email: person.email.toLowerCase(), picture: null, roles: vmmsRoles, temporaryRoles: [], isActive: person.state === 'active', deleted: person.state === 'deleted', erased: false },
      update: {},
    });
    const role = person.roles.find((assignment) => assignment.system === 'VMMS' && ['MECHANIC', 'CHIEF_MECHANIC'].includes(assignment.role))?.role;
    if (!role) continue;
    await prisma.mechanic.upsert({
      where: { userId: person.id },
      create: {
        userId: person.id, name: person.name, email: person.email.toLowerCase(), role,
        temporaryRoles: [], isOutsourced: false,
        isActive: person.state === 'active',
      },
      update: {},
    });
  }
}
