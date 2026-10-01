import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SetUserStatusDto } from './dto/set-user-status.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { OtpResetPasswordDto } from './dto/otp-reset-password.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  SendPhoneVerificationDto,
  VerifyPhoneDto,
} from './dto/phone-verification.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { getClientPlatform } from './client-platform';
import type { Response } from 'express';

const REFRESH_COOKIE = 'vmms_refresh_token';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: { ip?: string; headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) response: Response,
  ) {
    const clientPlatform = getClientPlatform(req.headers['x-vmms-client']);
    const session = await this.authService.login(
      dto,
      this.getLoginMetadata(req),
      clientPlatform,
    );
    if (clientPlatform === 'web') {
      this.setRefreshCookie(response, session.refreshToken);
      const { refreshToken: _refreshToken, ...webSession } = session;
      return webSession;
    }
    return session;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body('refreshToken') bodyRefreshToken: string | undefined,
    @Req() req: { headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) response: Response,
  ) {
    const clientPlatform = getClientPlatform(req.headers['x-vmms-client']);
    const refreshToken = clientPlatform === 'web'
      ? this.readRefreshCookie(req.headers.cookie)
      : bodyRefreshToken;
    let session: Awaited<ReturnType<AuthService['refreshSession']>>;
    try {
      session = await this.authService.refreshSession(refreshToken ?? '', clientPlatform);
    } catch (error) {
      if (clientPlatform === 'web') this.clearRefreshCookie(response);
      throw error;
    }
    if (clientPlatform === 'web') {
      this.setRefreshCookie(response, session.refreshToken);
      const { refreshToken: _refreshToken, ...webSession } = session;
      return webSession;
    }
    return session;
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
      user: { sub: string; email: string };
    },
    @Body('refreshToken') bodyRefreshToken: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const clientPlatform = getClientPlatform(req.headers['x-vmms-client']);
    const refreshToken = clientPlatform === 'web'
      ? this.readRefreshCookie(req.headers.cookie)
      : bodyRefreshToken;
    const result = await this.authService.recordLogout(
      req.user.sub,
      req.user.email,
      this.getLoginMetadata(req),
      refreshToken,
    );
    if (clientPlatform === 'web') this.clearRefreshCookie(response);
    return result;
  }

  private readRefreshCookie(header: string | string[] | undefined): string | undefined {
    const rawHeader = Array.isArray(header) ? header[0] : header;
    const cookie = rawHeader?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${REFRESH_COOKIE}=`));
    if (!cookie) return undefined;
    try { return decodeURIComponent(cookie.slice(REFRESH_COOKIE.length + 1)); } catch { return undefined; }
  }

  private setRefreshCookie(response: Response, token: string) {
    response.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'lax',
      path: '/auth',
      maxAge: this.refreshCookieMaxAge(),
    });
  }

  private clearRefreshCookie(response: Response) {
    response.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'lax',
      path: '/auth',
    });
  }

  private refreshCookieMaxAge() {
    const configured = process.env['JWT_REFRESH_EXPIRY'] ?? '7d';
    const match = /^([1-9]\d*)([smhd])$/.exec(configured.trim());
    if (!match) return 7 * 24 * 60 * 60 * 1000;
    const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return Number(match[1]) * units[match[2]];
  }

  private getLoginMetadata(req: {
    ip?: string;
    headers: Record<string, string | string[] | undefined>;
  }) {
    const userAgent = req.headers['user-agent'];
    return {
      ipAddress: req.ip ?? null,
      userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent ?? null,
    };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.email, dto.otp);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPasswordOtp(@Body() dto: OtpResetPasswordDto) {
    return this.authService.otpResetPassword(
      dto.email,
      dto.otp,
      dto.newPassword,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')

  me(@Req() req: { user: { sub: string } }) {
    return this.authService.getCurrentUser(req.user.sub);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('users')
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.authService.listUsers(query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('users/:id/login-activity')
  getLoginActivity(@Param('id', ParseUUIDPipe) id: string) {
    return this.authService.getLoginActivity(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('audit-logs')
  getAuditLogs(@Query('source') source?: string) {
    return this.authService.getAuditLogs(source);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('users')
  createUser(@Body() dto: CreateUserDto) {
    return this.authService.createUser(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('users/:id')
  updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    console.log('updateUser called with DTO:', dto);
    return this.authService.updateUser(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('users/:id/status')
  updateUserStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserStatusDto,
  ) {
    return this.authService.updateUserStatus(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete('users/:id')
  deleteUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.authService.deleteUser(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('users/:id/password')
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.authService.resetPassword(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('users/:id/unlock')
  unlockUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.authService.unlockUser(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  updateOwnProfile(
    @Req() req: { user: { sub: string } },
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateOwnProfile(req.user.sub, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('profile/phone/send-verification')
  sendPhoneVerification(
    @Req() req: { user: { sub: string } },
    @Body() dto: SendPhoneVerificationDto,
  ) {
    return this.authService.sendPhoneVerification(req.user.sub, dto.phone);
  }

  @UseGuards(JwtAuthGuard)
  @Post('profile/phone/verify')
  verifyPhone(
    @Req() req: { user: { sub: string } },
    @Body() dto: VerifyPhoneDto,
  ) {
    return this.authService.verifyPhone(req.user.sub, dto.phone, dto.code);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile/password')
  changeOwnPassword(
    @Req() req: { user: { sub: string } },
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changeOwnPassword(req.user.sub, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('profile/picture')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
      fileFilter: (_req, file, cb) => {
        const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
        const ext = file.originalname.toLowerCase().split('.').pop();
        if (!ext || !allowed.includes(`.${ext}`)) {
          return cb(new Error('Only image files are allowed'), false);
        }
        cb(null, true);
      },
    }),
  )
  uploadProfilePicture(
    @Req() req: { user: { sub: string } },
    @UploadedFile() file: { originalname: string; buffer: Buffer; size: number; mimetype: string },
  ) {
    return this.authService.uploadProfilePicture(req.user.sub, file);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile/summary')
  getProfileSummary(@Req() req: { user: { sub: string } }) {
    return this.authService.getProfileSummary(req.user.sub);
  }

}
