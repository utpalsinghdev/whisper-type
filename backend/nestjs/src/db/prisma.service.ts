import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly config: ConfigService) {
    const databaseUrl =
      process.env.DATABASE_URL ||
      `file:${path.resolve(config.get<string>('databasePath') || './data/wishpertype.db')}`;
    super({
      datasources: {
        db: { url: databaseUrl },
      },
    });
  }

  async onModuleInit() {
    const dbPath = this.config.get<string>('databasePath') || './data/wishpertype.db';
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    await this.$connect();
    this.logger.log(`Prisma SQLite connected (${dbPath})`);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
