import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../../auth/guards/roles.guard.js';
import { Roles } from '../../../auth/decorators/roles.decorator.js';
import { VmmsConfigService } from './config.service.js';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('config')
export class VmmsConfigController {
  constructor(private readonly configService: VmmsConfigService) {}

  @Roles(
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.MECHANIC,
    UserRole.CHIEF_MECHANIC,
  )
  @Get('garages')
  listGarages() {
    return this.configService.listGarages();
  }

  @Roles(
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.MECHANIC,
    UserRole.CHIEF_MECHANIC,
  )
  @Get('vehicles')
  listVehicles() {
    return this.configService.listVehicles();
  }

  @Roles(
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.MECHANIC,
    UserRole.CHIEF_MECHANIC,
  )
  @Get('systems')
  listSystems() {
    return this.configService.listSystems();
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get('outsourced-providers')
  listOutsourcedProviders() {
    return this.configService.listOutsourcedProviders();
  }

  @Roles(UserRole.OPERATIONS)
  @Post('outsourced-providers')
  createOutsourcedProvider(@Body() body: { name: string }) {
    return this.configService.createOutsourcedProvider(body.name);
  }

  @Roles(UserRole.OPERATIONS)
  @Patch('outsourced-providers/:id')
  updateOutsourcedProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string; isActive?: boolean },
  ) {
    return this.configService.updateOutsourcedProvider(id, body);
  }

  @Roles(UserRole.OPERATIONS)
  @Delete('outsourced-providers/:id')
  deleteOutsourcedProvider(@Param('id', ParseUUIDPipe) id: string) {
    return this.configService.deleteOutsourcedProvider(id);
  }
}
