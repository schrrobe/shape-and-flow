import { describe, expect, it, vi } from 'vitest';

import { FixedClock } from '../../domain/time/clock.js';

import { AuditRetentionService } from './audit-retention.service.js';

import type { PrismaService } from '../../prisma/prisma.service.js';

describe('AuditRetentionService', () => {
  it('deletes each organization audit history on its configured schedule', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { organizationId: 'short-retention', dataRetentionDays: 30 },
      { organizationId: 'long-retention', dataRetentionDays: 365 },
    ]);
    const deleteMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 3 });
    const prisma = {
      organizationSettings: { findMany },
      auditLog: { deleteMany },
    } as unknown as PrismaService;
    const now = new Date('2026-08-03T12:00:00.000Z');
    const service = new AuditRetentionService(prisma, new FixedClock(now));

    await expect(service.sweep()).resolves.toBe(5);
    expect(deleteMany).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: 'short-retention',
        createdAt: { lt: new Date('2026-07-04T12:00:00.000Z') },
      },
    });
    expect(deleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: 'long-retention',
        createdAt: { lt: new Date('2025-08-03T12:00:00.000Z') },
      },
    });
  });
});
