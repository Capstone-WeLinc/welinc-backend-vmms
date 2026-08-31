import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../../auth/guards/roles.guard.js';
import { Roles } from '../../../auth/decorators/roles.decorator.js';
import { VmmsConfigService } from './config.service.js';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vmms/config')
export class VmmsConfigController {
  constructor(private readonly configService: VmmsConfigService) {}

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Get('garages')
  listGarages() {
    return this.configService.listGarages();
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Get('vehicles')
  listVehicles() {
    return this.configService.listVehicles();
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Get('systems')
  listSystems() {
    return this.configService.listSystems();
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  @Get('users')
  listUsers() {
    return this.configService.listUsers();
  }
}
