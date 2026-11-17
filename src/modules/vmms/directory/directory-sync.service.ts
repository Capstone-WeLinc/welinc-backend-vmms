import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../shared/prisma.service';
import {
  AuthDirectoryClient,
  type DirectoryUser,
} from './auth-directory.client';
import { rewriteErased } from './erasure-rewrite';

const STATE_ID = 'auth';
const POLL_MS = 30_000;

@Injectable()
export class DirectorySync {
  private readonly logger = new Logger(DirectorySync.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: AuthDirectoryClient,
  ) {}

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let owner: string | null = null;
    try {
      await this.prisma.directorySyncState.upsert({
        where: { id: STATE_ID },
        create: { id: STATE_ID },
        update: {},
      });
      owner = randomUUID();
      const claim = await this.prisma.directorySyncState.updateMany({
        where: {
          id: STATE_ID,
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
        },
        data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 120_000) },
      });
      if (!claim.count) return;
      const state = await this.prisma.directorySyncState.findUniqueOrThrow({
        where: { id: STATE_ID },
      });
      if (state.cursor) {
        const page = await this.directory.changes(state.cursor);
        for (const change of page.changes) {
          await this.apply(change.user);
          await this.prisma.directorySyncState.update({
            where: { id: STATE_ID },
            data: { cursor: change.cursor, updatedAt: new Date() },
          });
        }
        if (page.next !== state.cursor && !page.changes.length) {
          await this.prisma.directorySyncState.update({
            where: { id: STATE_ID },
            data: { cursor: page.next, updatedAt: new Date() },
          });
        }
        return;
      }

      const seen = new Set<string>();
      let cursor: string | null = null;
      let firstChangeCursor = '';
      do {
        const page = await this.directory.listUsers(cursor);
        firstChangeCursor ||= page.changesCursor;
        for (const person of page.users) {
          seen.add(person.id);
          await this.apply(person);
        }
        cursor = page.next;
      } while (cursor);
      await this.prisma.mechanic.updateMany({
        where: { userId: { notIn: [...seen] }, isOutsourced: false },
        data: { isActive: false },
      });
      await this.prisma.vmmsPerson.deleteMany({
        where: { authUserId: { notIn: [...seen] } },
      });
      await this.prisma.directorySyncState.update({
        where: { id: STATE_ID },
        data: { cursor: firstChangeCursor || null, updatedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        `welinc-auth directory sync deferred: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (owner)
        await this.prisma.directorySyncState
          .updateMany({
            where: { id: STATE_ID, leaseOwner: owner },
            data: { leaseOwner: null, leaseUntil: null },
          })
          .catch(() => undefined);
      this.running = false;
    }
  }

  private async apply(person: DirectoryUser): Promise<void> {
    const permanent = person.roles.filter(
      (role) => !(person.temporaryRoles ?? []).includes(role),
    );
    const role = permanent.includes('CHIEF_MECHANIC')
      ? 'CHIEF_MECHANIC'
      : permanent.includes('MECHANIC')
        ? 'MECHANIC'
        : null;
    if (person.erased) {
      const erasedEmail = `deleted-${person.id}@erased.invalid`;
      await this.prisma.vmmsPerson.upsert({
        where: { authUserId: person.id },
        create: {
          authUserId: person.id,
          name: 'Deleted user',
          email: erasedEmail,
          picture: null,
          roles: [],
          temporaryRoles: [],
          isActive: false,
          deleted: true,
          erased: true,
        },
        update: {
          name: 'Deleted user',
          email: erasedEmail,
          picture: null,
          roles: [],
          temporaryRoles: [],
          isActive: false,
          deleted: true,
          erased: true,
        },
      });
      await this.prisma.mechanic.updateMany({
        where: { userId: person.id },
        data: { role: null, temporaryRoles: [], isActive: false },
      });
      await rewriteErased(this.prisma, person.id);
      return;
    }
    await this.prisma.vmmsPerson.upsert({
      where: { authUserId: person.id },
      create: {
        authUserId: person.id,
        name: person.name,
        email: person.email.toLowerCase(),
        picture: person.picture,
        roles: person.roles,
        temporaryRoles: person.temporaryRoles ?? [],
        isActive: person.isActive,
        deleted: person.deleted,
        erased: false,
      },
      update: {
        name: person.name,
        email: person.email.toLowerCase(),
        picture: person.picture,
        roles: person.roles,
        temporaryRoles: person.temporaryRoles ?? [],
        isActive: person.isActive,
        deleted: person.deleted,
        erased: false,
      },
    });
    if (!role) {
      await this.prisma.mechanic.updateMany({
        where: { userId: person.id },
        data: {
          isActive: false,
          role: null,
          temporaryRoles: person.temporaryRoles ?? [],
        },
      });
      return;
    }
    const data = {
      email: person.email.toLowerCase(),
      name: person.name,
      role,
      temporaryRoles: person.temporaryRoles ?? [],
      isActive: person.isActive && !person.deleted,
      isOutsourced: false,
    };
    await this.prisma.mechanic.upsert({
      where: { userId: person.id },
      create: { userId: person.id, ...data },
      update: data,
    });
  }
}

@Injectable()
export class DirectoryPollJob {
  constructor(private readonly sync: DirectorySync) {}

  @Interval(POLL_MS)
  async run(): Promise<void> {
    await this.sync.tick();
  }
}

export const DIRECTORY_POLL_INTERVAL = POLL_MS;
