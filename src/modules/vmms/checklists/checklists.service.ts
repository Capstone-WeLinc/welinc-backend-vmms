import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { CreateChecklistDto, UpdateChecklistDto } from './dto';

@Injectable()
export class ChecklistsService {
  constructor(private prisma: PrismaService) {}

  async create(createChecklistDto: CreateChecklistDto) {
    const { type, items } = createChecklistDto;
    const existing = await this.prisma.checklistTemplate.findUnique({
      where: { type },
    });

    if (existing) {
      await this.prisma.checklistItem.updateMany({
        where: { checklistTemplateId: existing.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      return this.prisma.checklistTemplate.update({
        where: { id: existing.id },
        data: {
          deletedAt: null,
          items: {
            create: items.map((item, index) => ({
              text: item.text,
              order: index,
            })),
          },
        },
        include: {
          items: {
            where: { deletedAt: null },
            orderBy: {
              order: 'asc',
            },
          },
        },
      });
    }

    return this.prisma.checklistTemplate.create({
      data: {
        type,
        items: {
          create: items.map((item, index) => ({
            text: item.text,
            order: index,
          })),
        },
      },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: {
            order: 'asc',
          },
        },
      },
    });
  }

  async findAll() {
    const templates = await this.prisma.checklistTemplate.findMany({
      where: { deletedAt: null },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: {
            order: 'asc',
          },
        },
      },
      orderBy: {
        type: 'asc',
      },
    });

    // Transform to match frontend format
    const result: Record<string, { id: string; text: string }[]> = {};
    templates.forEach((template) => {
      result[template.type] = template.items.map((item) => ({
        id: item.id,
        text: item.text,
      }));
    });

    return result;
  }

  async findOne(id: string) {
    return this.prisma.checklistTemplate.findFirst({
      where: { id, deletedAt: null },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: {
            order: 'asc',
          },
        },
      },
    });
  }

  async findByType(type: string) {
    return this.prisma.checklistTemplate.findFirst({
      where: { type, deletedAt: null },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: {
            order: 'asc',
          },
        },
      },
    });
  }

  async update(id: string, updateChecklistDto: UpdateChecklistDto) {
    const { items, ...otherData } = updateChecklistDto;

    // If items are being updated, archive old ones and create new ones.
    if (items) {
      await this.prisma.checklistItem.updateMany({
        where: { checklistTemplateId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    return this.prisma.checklistTemplate.update({
      where: { id },
      data: {
        ...otherData,
        items: items
          ? {
              create: items.map((item, index) => ({
                text: item.text,
                order: index,
              })),
            }
          : undefined,
      },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: {
            order: 'asc',
          },
        },
      },
    });
  }

  async updateByType(type: string, updateChecklistDto: UpdateChecklistDto) {
    const existing = await this.prisma.checklistTemplate.findFirst({
      where: { type, deletedAt: null },
    });

    if (!existing) {
      return this.create({
        type,
        items: updateChecklistDto.items || [],
      });
    }

    return this.update(existing.id, updateChecklistDto);
  }

  async remove(id: string) {
    await this.prisma.checklistItem.updateMany({
      where: { checklistTemplateId: id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return this.prisma.checklistTemplate.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async removeByType(type: string) {
    const template = await this.prisma.checklistTemplate.findFirst({
      where: { type, deletedAt: null },
    });

    if (!template) {
      return null;
    }

    return this.remove(template.id);
  }

  private async replaceTemplateItems(
    type: string,
    items: { id: string; text: string }[],
  ) {
    const existing = await this.prisma.checklistTemplate.findUnique({
      where: { type },
    });

    if (!existing) {
      return this.prisma.checklistTemplate.create({
        data: {
          type,
          items: {
            create: items.map((item, index) => ({
              text: item.text,
              order: index,
            })),
          },
        },
        include: {
          items: {
            where: { deletedAt: null },
            orderBy: {
              order: 'asc',
            },
          },
        },
      });
    }

    await this.prisma.checklistItem.updateMany({
      where: { checklistTemplateId: existing.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return this.prisma.checklistTemplate.update({
      where: { id: existing.id },
      data: {
        deletedAt: null,
        items: {
          create: items.map((item, index) => ({
            text: item.text,
            order: index,
          })),
        },
      },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: {
            order: 'asc',
          },
        },
      },
    });
  }

  async upsertMany(templates: Record<string, { id: string; text: string }[]>) {
    const activeTypes = Object.keys(templates);
    const templatesToRemove = await this.prisma.checklistTemplate.findMany({
      where: {
        deletedAt: null,
        ...(activeTypes.length > 0 ? { type: { notIn: activeTypes } } : {}),
      },
      select: { id: true },
    });

    for (const template of templatesToRemove) {
      await this.remove(template.id);
    }

    const created: Prisma.ChecklistTemplateGetPayload<{
      include: { items: true };
    }>[] = [];
    for (const [type, items] of Object.entries(templates)) {
      const template = await this.replaceTemplateItems(type, items);
      created.push(template);
    }

    // Return in frontend format
    const result: Record<string, { id: string; text: string }[]> = {};
    created.forEach((template) => {
      result[template.type] = template.items.map((item) => ({
        id: item.id,
        text: item.text,
      }));
    });

    return result;
  }
}
