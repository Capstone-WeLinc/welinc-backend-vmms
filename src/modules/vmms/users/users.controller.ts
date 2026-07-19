import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  UseGuards,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async list() {
    return this.usersService.findAll();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  async create(@Body() body: CreateUserDto) {
    // Expecting { name, username, passwordHash, role? }
    return this.usersService.create(body);
  }

  @Patch(':id/role')
  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  async setRole(
    @Param('id') id: string,
    @Body() body: { role: string },
    @Req() req,
  ) {
    const currentUserId = req.user?.sub;
    if (currentUserId === id) {
      throw new (require('@nestjs/common').ForbiddenException)(
        'You cannot edit your own account.',
      );
    }
    return this.usersService.setRole(id, body.role);
  }

  @Patch(':id/status')
  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  async setStatus(
    @Param('id') id: string,
    @Body() body: { status: string },
    @Req() req,
  ) {
    const currentUserId = req.user?.sub;
    if (currentUserId === id) {
      throw new (require('@nestjs/common').ForbiddenException)(
        'You cannot change your own account status.',
      );
    }
    return this.usersService.setStatus(id, body.status);
  }

  @Patch(':id/last-active')
  async setLastActive(@Param('id') id: string, @Req() req) {
    const currentUserId = req.user?.sub;
    if (currentUserId !== id) {
      throw new ForbiddenException(
        'You can only update your own last active timestamp.',
      );
    }
    return this.usersService.updateLastActive(id);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  async remove(@Param('id') id: string, @Req() req) {
    const currentUserId = req.user?.sub;
    if (currentUserId === id) {
      throw new (require('@nestjs/common').ForbiddenException)(
        'You cannot delete your own account.',
      );
    }
    return this.usersService.remove(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string; email?: string },
    @Req() req,
  ) {
    const currentUserId = req.user?.sub;
    if (currentUserId === id) {
      // allow admins to update their own display name only
      const roles = req.user?.roles || [];
      const isAdmin = roles.some(
        (r) => r.role === UserRole.ADMIN || r.role === 'ADMIN',
      );
      const bodyKeys = Object.keys(body || {});
      const onlyName =
        bodyKeys.length > 0 && bodyKeys.every((k) => k === 'name');
      if (!isAdmin || !onlyName) {
        throw new (require('@nestjs/common').ForbiddenException)(
          'You cannot edit your own account.',
        );
      }
    }
    return this.usersService.update(id, body);
  }
}
