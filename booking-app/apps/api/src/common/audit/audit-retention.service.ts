import { Inject, Injectable } from '@nestjs/common';

import { CLOCK } from '../../domain/time/clock.js';
import { PrismaService } from '../../prisma/prisma.service.js';

import type { Clock } from '../../domain/time/clock.js';

const DAY_MS = 86_400_000;

/** Applies each organization's configured retention period to its audit history. */
@Injectable()
export class AuditRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async sweep(): Promise<number> {
    const settings = await this.prisma.organizationSettings.findMany({
      select: { organizationId: true, dataRetentionDays: true },
    });

    const deleted = await Promise.all(
      settings.map(async ({ organizationId, dataRetentionDays }) => {
        const cutoff = new Date(this.clock.now().getTime() - dataRetentionDays * DAY_MS);
        const result = await this.prisma.auditLog.deleteMany({
          where: { organizationId, createdAt: { lt: cutoff } },
        });
        return result.count;
      }),
    );

    return deleted.reduce((total, count) => total + count, 0);
  }
}
