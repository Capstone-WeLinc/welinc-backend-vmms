import {
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';
import {
  RoleSystem,
  Roles,
} from '../../../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../auth/guards/roles.guard';
import { VrmsRepairReferralsService } from './vrms-repair-referrals.service';

@Controller('integrations/vrms/repair-referrals')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
export class VrmsRepairReferralsController {
  constructor(private readonly referrals: VrmsRepairReferralsService) {}

  @Roles(UserRole.ADMIN)
  @Post(':id/retry')
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.referrals.retryFailed(id);
  }
}
