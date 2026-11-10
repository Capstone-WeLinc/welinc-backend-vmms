import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as dns from 'dns';
import { SystemType, UserRole } from '@prisma/client';
import { PrismaService } from '../shared/prisma.service';
import { MailService } from '../shared/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SetUserStatusDto } from './dto/set-user-status.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RoleAssignmentDto } from './dto/role-assignment.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { assertSingleVmmsRoleAssignment } from './vmms-role-assignments';
import {
  assertVmmsPlatformAccess,
  type ClientPlatform,
} from './client-platform';

type PendingPhoneVerification = {
  phone: string;
  codeHash: string;
  expiresAt: number;
};

export type LoginRequestMetadata = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function validateEmailDomain(email: string): Promise<void> {
  const domain = email.split('@')[1];
  if (!domain) {
    throw new BadRequestException('Invalid email format');
  }

  const devDomains = ['welinc.com', 'localhost', 'test.com', 'example.com'];
  if (devDomains.includes(domain.toLowerCase())) {
    return;
  }

  return new Promise((resolve, reject) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        dns.resolve(domain, (err2, ips) => {
          if (err2 || !ips || ips.length === 0) {
            reject(new BadRequestException('Email domain does not exist or cannot receive mail'));
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  });
}

type RoleAssignment = {
  role: UserRole;
  system: SystemType;
};

const MAX_FAILED_ATTEMPTS = 5;

type ManagedUserRecord = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  contact: string | null;
  profilePicture: string | null;
  isActive: boolean;
  lockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  roles: RoleAssignment[];
};

export type AuthUserResponse = {
  id: string;
  name: string;
  email: string;
  contact: string | null;
  profilePicture: string | null;
  roles: RoleAssignment[];
};

export type ManagedUserResponse = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  contact: string | null;
  profilePicture: string | null;
  isActive: boolean;
  isLocked: boolean;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  roles: RoleAssignment[];
};

@Injectable()
export class AuthService {
  private readonly pendingPhoneVerifications = new Map<
    string,
    PendingPhoneVerification
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly config: ConfigService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async sendPhoneVerification(userId: string, phone: string) {
    await this.ensureUserExists(userId);

    const code = crypto.randomInt(100000, 1000000).toString();
    this.pendingPhoneVerifications.set(userId, {
      phone,
      codeHash: crypto.createHash('sha256').update(code).digest('hex'),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const isDryRun = this.config.get<string>('SEMAPHORE_DRY_RUN') === 'true';
    const apiKey = this.config.get<string>('SEMAPHORE_API_KEY');
    if (isDryRun) {
      console.log(`[PhoneVerification] OTP for ${userId}: ${code}`);
    } else {
      if (!apiKey || apiKey === 'your_semaphore_api_key_here') {
        throw new BadRequestException('Semaphore SMS is not configured.');
      }

      let response: Response;
      try {
        response = await fetch('https://api.semaphore.co/api/v4/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            apikey: apiKey,
            number: phone.replace('+', ''),
            message: `Your WELINC verification code is ${code}. It expires in 10 minutes.`,
            sendername: this.config.get<string>('SEMAPHORE_SENDER_NAME') ?? 'WELINC',
          }),
        });
      } catch {
        this.pendingPhoneVerifications.delete(userId);
        throw new BadRequestException('Unable to connect to Semaphore SMS service.');
      }

      const responseText = await response.text();
      if (!response.ok) {
        this.pendingPhoneVerifications.delete(userId);
        throw new BadRequestException(
          `Semaphore rejected the SMS request: ${responseText.slice(0, 200)}`,
        );
      }
    }

    return {
      message: 'A verification code has been sent to your phone.',
      ...(isDryRun ? { developmentCode: code } : {}),
    };
  }

  async verifyPhone(userId: string, phone: string, code: string) {
    const pending = this.pendingPhoneVerifications.get(userId);
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    if (
      !pending ||
      pending.phone !== phone ||
      pending.expiresAt < Date.now() ||
      pending.codeHash !== codeHash
    ) {
      throw new BadRequestException('Invalid or expired phone verification code.');
    }

    this.pendingPhoneVerifications.delete(userId);
    return this.updateOwnProfile(userId, { contact: phone });
  }

  async login(
    dto: LoginDto,
    metadata: LoginRequestMetadata = {},
    clientPlatform: ClientPlatform = 'web',
  ): Promise<{ accessToken: string; refreshToken: string; user: AuthUserResponse }> {
    // TODO: Transparent migration — if passwordHash starts with '$2b$' (bcrypt),
    // verify with bcrypt first, re-hash with argon2, then save. Requires bcrypt as
    // an optional dep. Skipped until all passwords are migrated.

    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        contact: true,
        profilePicture: true,
        passwordHash: true,
        isActive: true,
        failedLoginAttempts: true,
        lockedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
    });

    // User not found — generic message to prevent user enumeration
    if (!user) {
      await this.recordLoginActivity(null, dto.email, 'FAILED_LOGIN', metadata);
      throw new UnauthorizedException("Invalid credentials");
    }

    // Locked account check — must happen before password validation
    if (user.lockedAt !== null) {
      await this.recordLoginActivity(user.id, user.email, 'ACCOUNT_LOCKOUT', metadata);
      throw new ForbiddenException({
        message: "Account is locked. Contact your Admin to unlock.",
        remainingAttempts: 0,
        isLocked: true,
      });
    }

    // Deactivated account
    if (!user.isActive) {
      await this.recordLoginActivity(user.id, user.email, 'FAILED_LOGIN', metadata);
      throw new UnauthorizedException("Invalid credentials");
    }

    const isPasswordValid = await argon2.verify(user.passwordHash, dto.password);

    if (!isPasswordValid) {
      const newAttempts = user.failedLoginAttempts + 1;
      const shouldLock = newAttempts >= MAX_FAILED_ATTEMPTS;

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: newAttempts,
          ...(shouldLock ? { lockedAt: new Date() } : {}),
        },
      });

      await this.recordLoginActivity(user.id, user.email, 'FAILED_LOGIN', metadata);
      if (shouldLock) {
        await this.recordLoginActivity(user.id, user.email, 'ACCOUNT_LOCKOUT', metadata);
      }

      if (shouldLock) {
        throw new ForbiddenException({
          message: "Account is locked. Contact your Admin to unlock.",
          remainingAttempts: 0,
          isLocked: true,
        });
      }

      throw new UnauthorizedException({
        message: "Invalid credentials",
        remainingAttempts: MAX_FAILED_ATTEMPTS - newAttempts,
        isLocked: false,
      });
    }

    // Successful login — reset failure counter
    try {
      assertVmmsPlatformAccess(user.roles, clientPlatform);
    } catch (error) {
      await this.recordLoginActivity(
        user.id,
        user.email,
        'PLATFORM_ACCESS_DENIED',
        metadata,
      );
      throw error;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0 },
    });

    await this.recordLoginActivity(user.id, user.email, 'SUCCESSFUL_LOGIN', metadata);

    const payload = {
      sub: user.id,
      email: user.email,
      roles: user.roles.map((r) => ({ role: r.role, system: r.system })),
      clientPlatform,
    };
    const refreshToken = await this.issueRefreshToken(user.id, clientPlatform);

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        contact: user.contact,
        profilePicture: user.profilePicture,
        roles: user.roles.map((r) => ({ role: r.role, system: r.system })),
      },
    };
  }

  async refreshSession(refreshToken: string, clientPlatform: ClientPlatform) {
    if (!refreshToken || refreshToken.length > 256) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    const tokenHash = this.hashRefreshToken(refreshToken);
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!storedToken || storedToken.clientPlatform !== clientPlatform || storedToken.expiresAt <= new Date()) {
      if (storedToken) await this.prisma.refreshToken.deleteMany({ where: { id: storedToken.id } });
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: storedToken.userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        isActive: true,
        lockedAt: true,
        roles: { select: { role: true, system: true } },
      },
    });
    if (!user?.isActive || user.lockedAt !== null) {
      await this.prisma.refreshToken.deleteMany({ where: { userId: storedToken.userId } });
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }
    assertVmmsPlatformAccess(user.roles, clientPlatform);

    const nextRefreshToken = this.createRawRefreshToken();
    const nextExpiry = this.getRefreshTokenExpiry();
    await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.refreshToken.deleteMany({
        where: { id: storedToken.id, tokenHash, expiresAt: { gt: new Date() } },
      });
      if (revoked.count !== 1) throw new UnauthorizedException('Refresh token was already used.');
      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: this.hashRefreshToken(nextRefreshToken),
          clientPlatform,
          expiresAt: nextExpiry,
        },
      });
    });

    const payload = {
      sub: user.id,
      email: user.email,
      roles: user.roles.map((role) => ({ role: role.role, system: role.system })),
      clientPlatform,
    };
    return { accessToken: this.jwtService.sign(payload), refreshToken: nextRefreshToken };
  }

  async recordLogout(userId: string, email: string, metadata: LoginRequestMetadata = {}, refreshToken?: string) {
    if (refreshToken) {
      await this.prisma.refreshToken.deleteMany({
        where: { userId, tokenHash: this.hashRefreshToken(refreshToken) },
      });
    }
    await this.recordLoginActivity(userId, email, 'LOGOUT', metadata);
    return { message: 'Logout recorded.' };
  }

  private async issueRefreshToken(userId: string, clientPlatform: ClientPlatform) {
    const refreshToken = this.createRawRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashRefreshToken(refreshToken),
        clientPlatform,
        expiresAt: this.getRefreshTokenExpiry(),
      },
    });
    return refreshToken;
  }

  private createRawRefreshToken() {
    return crypto.randomBytes(48).toString('base64url');
  }

  private hashRefreshToken(token: string) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private getRefreshTokenExpiry() {
    const configured = this.config.get<string>('JWT_REFRESH_EXPIRY') ?? '7d';
    const match = /^([1-9]\d*)([smhd])$/.exec(configured.trim());
    if (!match) throw new Error('JWT_REFRESH_EXPIRY must use seconds, minutes, hours, or days (for example 7d).');
    const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return new Date(Date.now() + Number(match[1]) * units[match[2]]);
  }

  async getLoginActivity(userId: string) {
    await this.ensureUserExists(userId);
    return this.prisma.loginActivity.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        event: true,
        email: true,
        ipAddress: true,
        deviceType: true,
        createdAt: true,
      },
    });
  }

  async getAuditLogs(source = 'all') {
    const supportedSources = ['all', 'login', 'vehicle', 'work-order', 'schedule', 'fuel'];
    if (!supportedSources.includes(source)) {
      throw new BadRequestException(`Source must be one of: ${supportedSources.join(', ')}.`);
    }

    const take = 500;
    const requests: Promise<any[]>[] = [];
    if (source === 'all' || source === 'login') {
      requests.push(this.prisma.loginActivity.findMany({
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, email: true, event: true, ipAddress: true, deviceType: true, createdAt: true },
      }).then((rows) => rows.map((row) => ({
        id: `login:${row.id}`, source: 'login', actor: row.email, action: row.event,
        entity: row.deviceType, details: row.ipAddress ? `IP ${row.ipAddress}` : null,
        previousValue: null, newValue: null, createdAt: row.createdAt,
      }))));
    }
    if (source === 'all' || source === 'vehicle') {
      requests.push(this.prisma.vehicleAuditLog.findMany({
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, email: true, action: true, fieldName: true, previousValue: true, newValue: true, createdAt: true, vehicle: { select: { plateNumber: true } } },
      }).then((rows) => rows.map((row) => ({
        id: `vehicle:${row.id}`, source: 'vehicle', actor: row.email, action: row.action,
        entity: row.vehicle.plateNumber, details: row.fieldName,
        previousValue: row.previousValue, newValue: row.newValue, createdAt: row.createdAt,
      }))));
    }
    if (source === 'all' || source === 'work-order') {
      requests.push(this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, email: true, action: true, fieldName: true, previousValue: true, newValue: true, createdAt: true, workOrder: { select: { workOrderNumber: true } } },
      }).then((rows) => rows.map((row) => ({
        id: `work-order:${row.id}`, source: 'work-order', actor: row.email, action: row.action,
        entity: row.workOrder.workOrderNumber, details: row.fieldName,
        previousValue: row.previousValue, newValue: row.newValue, createdAt: row.createdAt,
      }))));
    }
    if (source === 'all' || source === 'schedule') {
      requests.push(this.prisma.maintenanceScheduleCancellation.findMany({
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, actorName: true, actorEmail: true, reason: true, previousStatus: true, createdAt: true, schedule: { select: { id: true } } },
      }).then((rows) => rows.map((row) => ({
        id: `schedule:${row.id}`, source: 'schedule', actor: row.actorName || row.actorEmail,
        action: 'SCHEDULE_CANCELLED', entity: row.schedule.id, details: row.reason,
        previousValue: row.previousStatus, newValue: 'CANCELLED', createdAt: row.createdAt,
      }))));
    }
    if (source === 'all' || source === 'fuel') {
      requests.push(this.prisma.fuelAuditLog.findMany({
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, actorEmail: true, action: true, reason: true, details: true, createdAt: true, fillUp: { select: { vehicle: { select: { plateNumber: true } } } } },
      }).then((rows) => rows.map((row) => ({
        id: `fuel:${row.id}`, source: 'fuel', actor: row.actorEmail, action: row.action,
        entity: row.fillUp?.vehicle.plateNumber ?? 'Fuel report', details: row.reason ?? (row.details ? JSON.stringify(row.details) : null),
        previousValue: null, newValue: null, createdAt: row.createdAt,
      }))));
      requests.push(this.prisma.fuelAnomalyThresholdAudit.findMany({
        orderBy: { changedAt: 'desc' }, take,
        select: { id: true, actorEmail: true, previousThreshold: true, newThreshold: true, changedAt: true },
      }).then((rows) => rows.map((row) => ({
        id: `fuel-threshold:${row.id}`, source: 'fuel', actor: row.actorEmail,
        action: 'FUEL_ANOMALY_THRESHOLD_CHANGED', entity: 'Fuel anomaly threshold',
        details: 'Deviation below rolling average', previousValue: row.previousThreshold == null ? null : `${row.previousThreshold}%`,
        newValue: `${row.newThreshold}%`, createdAt: row.changedAt,
      }))));
    }

    const groups = await Promise.all(requests);
    return groups.flat().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take);
  }

  private async recordLoginActivity(
    userId: string | null,
    email: string,
    event: string,
    metadata: LoginRequestMetadata,
  ) {
    const userAgent = metadata.userAgent?.slice(0, 2000) ?? null;
    await this.prisma.loginActivity.create({
      data: {
        userId,
        email: email.slice(0, 255),
        event,
        ipAddress: metadata.ipAddress?.slice(0, 45) ?? null,
        deviceType: this.getDeviceType(userAgent),
        userAgent,
      },
    });
  }

  private getDeviceType(userAgent: string | null): string {
    if (!userAgent) return 'Unknown';
    if (/ipad|tablet|kindle/i.test(userAgent)) return 'Tablet';
    if (/mobile|iphone|android/i.test(userAgent)) return 'Mobile';
    return 'Desktop';
  }

  async unlockUser(userId: string): Promise<ManagedUserResponse> {
    await this.ensureUserExists(userId);

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        lockedAt: null,
        failedLoginAttempts: 0,
      },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        contact: true,
        profilePicture: true,
        isActive: true,
        lockedAt: true,
        createdAt: true,
        updatedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
    });

    await this.prisma.refreshToken.deleteMany({ where: { userId } });

    return this.mapManagedUser(user);
  }

  async listUsers(query: ListUsersQueryDto): Promise<ManagedUserResponse[]> {
    const users = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(query.system
          ? {
              roles: {
                some: {
                  system: query.system,
                },
              },
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        contact: true,
        profilePicture: true,
        isActive: true,
        lockedAt: true,
        createdAt: true,
        updatedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return users.map((user) => this.mapManagedUser(user));
  }

  async createUser(dto: CreateUserDto): Promise<ManagedUserResponse> {
    const roleAssignments = this.normalizeRoleAssignments(dto.roleAssignments);
    assertSingleVmmsRoleAssignment(roleAssignments);
    await validateEmailDomain(dto.email);

    try {
      let passwordHash: string;
      let setupOtp: string | null = null;

      if (dto.password) {
        passwordHash = await argon2.hash(dto.password);
      } else {
        const tempPassword = crypto.randomBytes(32).toString('hex');
        passwordHash = await argon2.hash(tempPassword);
        setupOtp = Math.floor(100000 + Math.random() * 900000).toString();
      }

      const user = await this.prisma.user.create({
        data: {
          name: dto.name.trim(),
          email: dto.email.trim().toLowerCase(),
          passwordHash,
          isActive: dto.isActive ?? true,
          roles: {
            create: roleAssignments,
          },
        },
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          contact: true,
          profilePicture: true,
          isActive: true,
          lockedAt: true,
          createdAt: true,
          updatedAt: true,
          roles: {
            select: {
              role: true,
              system: true,
            },
          },
        },
      });

      if (setupOtp) {
        const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour
        await this.prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            otp: setupOtp,
            expiresAt,
          },
        });

        const setupLink = 'http://localhost:8000/forgot-password';
        const mailContent = `Welcome to WeLinc Logistics, ${user.name}!

Your account has been created by the administrator.
To set up your password, please use the following one-time code:

Setup Code: ${setupOtp}

Please visit the link below to set up your password:
${setupLink}

This code will expire in 1 hour.`;

        await this.mailService.sendMail({
          to: user.email,
          subject: 'WeLinc Logistics - Account Setup',
          text: mailContent,
          html: `<p>Welcome to WeLinc Logistics, <strong>${user.name}</strong>!</p>
<p>Your account has been created by the administrator.</p>
<p>To set up your password, please use the following one-time code:</p>
<h2 style="font-size: 24px; font-weight: bold; color: #1a1f6e; letter-spacing: 2px;">${setupOtp}</h2>
<p>Please visit the link below to set up your password:</p>
<p><a href="${setupLink}" style="color: #1a1f6e; font-weight: bold; text-decoration: underline;">Set up your password</a></p>
<p>This code will expire in 1 hour.</p>`,
        });
      }

      return this.mapManagedUser(user);
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  async updateUser(
    userId: string,
    dto: UpdateUserDto,
  ): Promise<ManagedUserResponse> {
    const existingUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        deletedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
    });

    if (!existingUser || existingUser.deletedAt) {
      throw new NotFoundException("User not found");
    }

    const isEmailChanging = !!(dto.email && dto.email.trim().toLowerCase() !== existingUser.email.toLowerCase());
    if (isEmailChanging && dto.email) {
      await validateEmailDomain(dto.email);
    }

    const roleAssignments = dto.roleAssignments
      ? this.mergeRoleAssignments(
          existingUser.roles,
          this.normalizeRoleAssignments(dto.roleAssignments),
        )
      : undefined;

    if (dto.roleAssignments) {
      assertSingleVmmsRoleAssignment(
        roleAssignments!.filter((assignment) => assignment.system === SystemType.VMMS),
      );
    }

    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(dto.name ? { name: dto.name.trim() } : {}),
          ...(isEmailChanging && dto.email ? { email: dto.email.trim().toLowerCase() } : {}),
          ...(dto.password
            ? { passwordHash: await argon2.hash(dto.password) }
            : {}),
          ...(typeof dto.isActive === "boolean"
            ? { isActive: dto.isActive }
            : {}),
          ...(roleAssignments
            ? {
                roles: {
                  deleteMany: {},
                  create: roleAssignments,
                },
              }
            : {}),
        },
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          contact: true,
          profilePicture: true,
          isActive: true,
          lockedAt: true,
          createdAt: true,
          updatedAt: true,
          roles: {
            select: {
              role: true,
              system: true,
            },
          },
        },
      });

      return this.mapManagedUser(user);
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  async updateUserStatus(
    userId: string,
    dto: SetUserStatusDto,
  ): Promise<ManagedUserResponse> {
    await this.ensureUserExists(userId);

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        isActive: dto.isActive,
      },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        contact: true,
        profilePicture: true,
        isActive: true,
        lockedAt: true,
        createdAt: true,
        updatedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
    });

    return this.mapManagedUser(user);
  }

  async deleteUser(userId: string): Promise<{ id: string }> {
    await this.ensureUserExists(userId);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        isActive: false,
        lockedAt: null,
      },
    });

    return { id: userId };
  }

  /**
   * Admin-only: reset a user's password by userId.
   */
  async resetPassword(
    userId: string,
    dto: ResetPasswordDto,
  ): Promise<ManagedUserResponse> {
    await this.ensureUserExists(userId);

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await argon2.hash(dto.password),
        failedLoginAttempts: 0,
        lockedAt: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        contact: true,
        profilePicture: true,
        isActive: true,
        lockedAt: true,
        createdAt: true,
        updatedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
    });

    await this.prisma.refreshToken.deleteMany({ where: { userId } });

    return this.mapManagedUser(user);
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true },
    });

    // Always return success to prevent user enumeration
    if (!user) {
      return { message: 'If that email is registered, an OTP has been sent.' };
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        otp,
        expiresAt,
      },
    });

    const setupLink = 'http://localhost:8000/forgot-password';
    const mailContent = `Hello, ${user.name || 'User'}!

You have requested to reset your password.
Please use the following one-time code to complete the process:

Reset Code: ${otp}

Please visit the link below to verify and reset your password:
${setupLink}

This code will expire in 10 minutes.`;

    await this.mailService.sendMail({
      to: user.email,
      subject: 'WeLinc Logistics - Password Reset Request',
      text: mailContent,
      html: `<p>Hello, <strong>${user.name || 'User'}</strong>!</p>
<p>You have requested to reset your password.</p>
<p>Please use the following one-time code to complete the process:</p>
<h2 style="font-size: 24px; font-weight: bold; color: #1a1f6e; letter-spacing: 2px;">${otp}</h2>
<p>Please visit the link below to verify and reset your password:</p>
<p><a href="${setupLink}" style="color: #1a1f6e; font-weight: bold; text-decoration: underline;">Reset your password</a></p>
<p>This code will expire in 10 minutes.</p>`,
    });

    console.log(`[ForgotPassword] OTP for ${email}: ${otp}`);

    return { message: 'If that email is registered, an OTP has been sent.' };
  }

  async verifyOtp(email: string, otp: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    const token = await this.prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token || token.otp !== otp) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    return { message: 'OTP is valid' };
  }

  /**
   * Public: verify OTP and set a new password.
   */
  async otpResetPassword(
    email: string,
    otp: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    const token = await this.prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token || token.otp !== otp) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    // Mark token as used, update password, and set emailVerified to true atomically
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await argon2.hash(newPassword),
          emailVerified: true,
        },
      }),
    ]);
    await this.prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    return { message: 'Password has been reset successfully.' };
  }

  async getCurrentUser(userId: string): Promise<ManagedUserResponse> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        contact: true,
        profilePicture: true,
        isActive: true,
        lockedAt: true,
        createdAt: true,
        updatedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    return this.mapManagedUser(user);
  }

  async updateOwnProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<ManagedUserResponse> {
    await this.ensureUserExists(userId);

    if (dto.email) {
      const emailLower = dto.email.trim().toLowerCase();
      const currentUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (currentUser && currentUser.email.toLowerCase() !== emailLower) {
        await validateEmailDomain(dto.email);
      }
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.name != null ? { name: dto.name.trim() } : {}),
        ...(dto.email != null ? { email: dto.email.trim().toLowerCase() } : {}),
        ...(dto.contact != null ? { contact: dto.contact.trim() || null } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        contact: true,
        profilePicture: true,
        isActive: true,
        lockedAt: true,
        createdAt: true,
        updatedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
    });

    if (dto.name != null || dto.email != null || dto.contact != null) {
      await this.notificationsService.createForUser(userId, {
        title: 'Profile updated',
        message: 'Your profile details were updated successfully.',
        type: 'success',
      });
    }

    return this.mapManagedUser(user);
  }

  async changeOwnPassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<ManagedUserResponse> {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException(
        "New password and confirm password do not match",
      );
    }

    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        passwordHash: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    const isCurrentPasswordValid = await argon2.verify(
      user.passwordHash,
      dto.currentPassword,
    );

    if (!isCurrentPasswordValid) {
      throw new BadRequestException("Current password is incorrect");
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await argon2.hash(dto.newPassword),
      },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        contact: true,
        profilePicture: true,
        isActive: true,
        lockedAt: true,
        createdAt: true,
        updatedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
    });

    await this.prisma.refreshToken.deleteMany({ where: { userId } });

    await this.notificationsService.createForUser(userId, {
      title: 'Security notice',
      message: 'Your password was changed successfully.',
      type: 'warning',
    });

    return this.mapManagedUser(updated);
  }

  async uploadProfilePicture(
    userId: string,
    file: { originalname: string; buffer: Buffer; size: number; mimetype: string },
  ): Promise<ManagedUserResponse> {
    await this.ensureUserExists(userId);

    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `${userId}${ext}`;
    const uploadDir = path.resolve('uploads', 'profiles');

    await fs.mkdir(uploadDir, { recursive: true });

    const filePath = path.join(uploadDir, filename);
    await fs.writeFile(filePath, file.buffer);

    const profilePicture = `/uploads/profiles/${filename}`;

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { profilePicture },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        contact: true,
        profilePicture: true,
        isActive: true,
        lockedAt: true,
        createdAt: true,
        updatedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
    });

    return this.mapManagedUser(user);
  }

  async getProfileSummary(userId: string) {
    await this.ensureUserExists(userId);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalLogs, logsThisMonth, inProgress, completed, totalCards] =
      await Promise.all([
        this.prisma.auditLog.count({
          where: { userId },
        }),
        this.prisma.auditLog.count({
          where: {
            userId,
            createdAt: { gte: startOfMonth },
          },
        }),
        this.prisma.workOrder.count({
          where: { status: 'IN_PROGRESS' },
        }),
        this.prisma.workOrder.count({
          where: { status: 'COMPLETED' },
        }),
        this.prisma.workOrder.count(),
      ]);

    return {
      totalLogs,
      logsThisMonth,
      inProgress,
      completed,
      totalCards,
    };
  }

  private normalizeRoleAssignments(
    roleAssignments: RoleAssignmentDto[],
  ): RoleAssignment[] {
    if (roleAssignments.length === 0) {
      throw new BadRequestException("At least one role assignment is required");
    }

    const seen = new Set<string>();
    const normalized = roleAssignments.map((assignment) => ({
      role: assignment.role,
      system: assignment.system,
    }));


    for (const assignment of normalized) {
      const key = `${assignment.role}:${assignment.system}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          "Duplicate role assignments are not allowed",
        );
      }
      seen.add(key);
    }

    return normalized;
  }

  private mergeRoleAssignments(
    existingRoles: RoleAssignment[],
    newRoles: RoleAssignment[],
  ): RoleAssignment[] {
    const systemsToReplace = new Set(
      newRoles.map((assignment) => assignment.system),
    );
    const retainedRoles = existingRoles.filter(
      (assignment) => !systemsToReplace.has(assignment.system),
    );
    return [...retainedRoles, ...newRoles];
  }

  private mapManagedUser(user: ManagedUserRecord): ManagedUserResponse {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      contact: user.contact,
      profilePicture: user.profilePicture,
      isActive: user.isActive,
      isLocked: user.lockedAt !== null,
      lockedAt: user.lockedAt ? user.lockedAt.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      roles: user.roles.map((role) => ({
        role: role.role,
        system: role.system,
      })),
    };
  }

  private async ensureUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }
  }

  private handlePrismaError(error: unknown): never {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        throw new ConflictException('Email already exists');
      }
    }

    throw error as Error;
  }
}
