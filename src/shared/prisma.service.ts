import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
  private readonly pool: pg.Pool;

  constructor() {
    const pool = new pg.Pool({
      connectionString: process.env['DATABASE_URL'],
      max: Number.isSafeInteger(Number(process.env['DB_POOL_MAX'])) && Number(process.env['DB_POOL_MAX']) > 0
        ? Number(process.env['DB_POOL_MAX'])
        : 2,
    });
    const adapter = new PrismaPg(pool);

    super({ adapter });

    this.pool = pool;
  }

  async onApplicationShutdown() {
    await this.$disconnect();
    await this.pool.end();
  }
}
