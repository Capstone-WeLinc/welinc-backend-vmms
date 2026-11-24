import {
  Body,
  Controller,
  Get,
  Patch,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { RoleSystem, Roles } from '../../../auth/decorators/roles.decorator';
import { UpdateSettingsCatalogDto } from './settings.dto';
import {
  SettingsCatalogActor,
  SettingsCatalogService,
} from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
export class SettingsCatalogController {
  constructor(private readonly settings: SettingsCatalogService) {}

  @Roles(UserRole.ADMIN)
  @Get('catalog')
  getCatalog(@Req() req: { user: SettingsCatalogActor }) {
    return this.settings.getCatalog(req.user);
  }

  @Roles(UserRole.ADMIN)
  @Patch('catalog/:key')
  updateCatalog(
    @Param('key') key: string,
    @Body() body: UpdateSettingsCatalogDto,
    @Req() req: { user: SettingsCatalogActor },
  ) {
    return this.settings.updateCatalog(key, body.value, req.user);
  }
}
