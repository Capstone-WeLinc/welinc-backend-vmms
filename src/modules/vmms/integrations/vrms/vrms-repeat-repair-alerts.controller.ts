import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ServiceToken } from '../../../../auth/verify/token-verifier';
import { ServiceRoute } from '../../../../auth/verify/guards';
import { VrmsRepeatRepairAlertDto } from './vrms-repeat-repair-alert.dto';
import { VrmsRepeatRepairAlertsService } from './vrms-repeat-repair-alerts.service';

type ServiceRequest = Request & { service?: ServiceToken };

@Controller('integrations/vrms')
@ServiceRoute('repair.repeat.write', 'vrms')
export class VrmsRepeatRepairAlertsController {
  constructor(
    private readonly repeatRepairAlerts: VrmsRepeatRepairAlertsService,
  ) {}

  @Post('repeat-repairs')
  async receive(
    @Body() event: VrmsRepeatRepairAlertDto,
    @Req() request: ServiceRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.service?.clientId !== 'vrms') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only the VRMS service may send repeated-repair alerts.',
      });
    }
    return this.repeatRepairAlerts.receive(event);
  }
}
