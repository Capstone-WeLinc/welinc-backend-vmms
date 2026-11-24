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
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { VmmsConfigService } from './config.service';
import {
  CreateOutsourcedProviderDto,
  UpdateOutsourcedProviderDto,
} from './dto/outsourced-provider.dto';

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
  createOutsourcedProvider(@Body() body: CreateOutsourcedProviderDto) {
    return this.configService.createOutsourcedProvider(body.name);
  }

  @Roles(UserRole.OPERATIONS)
  @Patch('outsourced-providers/:id')
  updateOutsourcedProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateOutsourcedProviderDto,
  ) {
    return this.configService.updateOutsourcedProvider(id, body);
  }

  @Roles(UserRole.OPERATIONS)
  @Delete('outsourced-providers/:id')
  deleteOutsourcedProvider(@Param('id', ParseUUIDPipe) id: string) {
    return this.configService.deleteOutsourcedProvider(id);
  }
}
