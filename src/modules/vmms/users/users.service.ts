import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../../shared/prisma.service';
import { validateEmailDomain } from '../../../auth/auth.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      include: { roles: true },
    });

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.roles.length > 0 ? u.roles[0].role : null,
      status: u.isActive ? 'Active' : 'Inactive',
      lastActive: u.updatedAt,
      rawRoles: u.roles,
    }));
  }

  async findOne(id: string) {
    const u = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: { roles: true },
    });
    if (!u) return null;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.roles.length > 0 ? u.roles[0].role : null,
      status: u.isActive ? 'Active' : 'Inactive',
      lastActive: u.updatedAt,
      rawRoles: u.roles,
    };
  }

  async create(data: {
    name: string;
    email: string;
    passwordHash: string;
    role?: string;
    system?: string;
  }) {
    const {
      role = 'OPERATIONS',
      system = 'VMMS',
      passwordHash,
      ...userData
    } = data;

    const emailLower = data.email.trim().toLowerCase();
    await validateEmailDomain(data.email);

    // Hash the password before storing
    const hashedPassword = await argon2.hash(passwordHash);

    const user = await this.prisma.user.create({
      data: {
        ...userData,
        email: emailLower,
        passwordHash: hashedPassword,
        isActive: true,
        roles: {
          create: {
            role: role as any,
            system: system as any,
          },
        },
      },
      include: { roles: true },
    });

    return user;
  }

  async setRole(userId: string, role: string, system = 'VMMS') {
    // upsert role assignment
    return this.prisma.userRoleAssignment.upsert({
      where: {
        userId_role_system: {
          userId,
          role: role as any,
          system: system as any,
        },
      },
      update: {},
      create: {
        userId,
        role: role as any,
        system: system as any,
      },
    });
  }

  async setStatus(userId: string, status: string) {
    const isActive = status === 'Active';
    return this.prisma.user.update({
      where: { id: userId },
      data: { isActive },
    });
  }

  async remove(userId: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async update(userId: string, data: { name?: string; email?: string }) {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.email !== undefined) {
      const emailLower = data.email.trim().toLowerCase();
      const currentUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (currentUser && currentUser.email.toLowerCase() !== emailLower) {
        await validateEmailDomain(data.email);
      }
      updateData.email = emailLower;
    }
    return this.prisma.user.update({ where: { id: userId }, data: updateData });
  }

  async updateLastActive(
    userId: string,
    lastActive = new Date().toISOString(),
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { updatedAt: new Date(lastActive) },
    });
  }
}
