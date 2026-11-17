import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles, RoleSystem } from '../../../auth/decorators/roles.decorator';
import { SystemType, UserRole } from '@prisma/client';
import { VmmsConfigService } from '../config/config.service';

@Controller('mechanics')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
export class MechanicsController {
  constructor(private readonly config: VmmsConfigService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  list() {
    return this.config.listMechanics();
  }
}
