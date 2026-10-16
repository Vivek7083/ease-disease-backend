import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

interface PackageJson {
  version: string;
}

const packageJson: PackageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
) as PackageJson;

export interface HealthStatus {
  status: 'ok';
  version: string;
  db: 'ok' | 'error';
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthStatus> {
    const db = await this.checkDb();
    return { status: 'ok', version: packageJson.version, db };
  }

  private async checkDb(): Promise<'ok' | 'error'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch (err) {
      this.logger.error('Database health check failed', (err as Error)?.stack);
      return 'error';
    }
  }
}
