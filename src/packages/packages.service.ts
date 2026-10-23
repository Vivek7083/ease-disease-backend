import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface PackageItem {
  id: string;
  title: string;
  description: string[];
  /** The current price: what is charged. */
  pricePaise: number;
  /** The old price to show struck through, or null when there is none. Always higher than `pricePaise` when set. */
  originalPricePaise: number | null;
  currency: 'INR';
  durationMinutes: number;
}

@Injectable()
export class PackagesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Packages on sale, cheapest first then oldest first. Only the fields the site shows: no flags, no timestamps. */
  async listActive(): Promise<{ packages: PackageItem[] }> {
    const rows = await this.prisma.package.findMany({
      where: { isActive: true },
      orderBy: [{ pricePaise: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, title: true, description: true, pricePaise: true, originalPricePaise: true, durationMinutes: true },
    });
    return {
      packages: rows.map((row) => ({
        id: row.id,
        title: row.title,
        // The database guarantees a json array; keep only strings so a bad row can never break the page.
        description: Array.isArray(row.description) ? row.description.filter((point): point is string => typeof point === 'string') : [],
        pricePaise: row.pricePaise,
        originalPricePaise: row.originalPricePaise,
        currency: 'INR',
        durationMinutes: row.durationMinutes,
      })),
    };
  }
}
