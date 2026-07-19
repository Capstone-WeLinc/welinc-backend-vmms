import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';

@Injectable()
export class DriversService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.driver.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: { name: string; licenseNumber: string; isVerified?: boolean }) {
    return this.prisma.driver.create({
      data: {
        name: dto.name.trim(),
        licenseNumber: dto.licenseNumber.trim(),
        isVerified: dto.isVerified ?? false,
      },
    });
  }

  async update(id: string, dto: { name?: string; licenseNumber?: string; isVerified?: boolean; isActive?: boolean }) {
    return this.prisma.driver.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.licenseNumber ? { licenseNumber: dto.licenseNumber.trim() } : {}),
        ...(dto.isVerified !== undefined ? { isVerified: dto.isVerified } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async delete(id: string) {
    return this.prisma.driver.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isActive: false,
      },
    });
  }
}
