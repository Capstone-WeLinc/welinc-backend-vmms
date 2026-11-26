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
import { VrmsRetirementRequestDto } from './vrms-retirement-request.dto';
import { VrmsRetirementRequestsService } from './vrms-retirement-requests.service';

type ServiceRequest = Request & { service?: ServiceToken };

@Controller('integrations/vrms')
@ServiceRoute('vehicle.retire.write', 'vrms')
export class VrmsRetirementRequestsController {
  constructor(
    private readonly retirementRequests: VrmsRetirementRequestsService,
  ) {}

  @Post('retirement-requests')
  async receive(
    @Body() event: VrmsRetirementRequestDto,
    @Req() request: ServiceRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.service?.clientId !== 'vrms') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only the VRMS service may send retirement requests.',
      });
    }
    return this.retirementRequests.receive(event);
  }
}
