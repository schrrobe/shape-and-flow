import { describe, expect, it, vi } from 'vitest';

import { PrismaLifecycle } from './prisma.lifecycle.js';

import type { PrismaService } from './prisma.service.js';

describe('PrismaLifecycle', () => {
  it('connects at module initialization and disconnects at application shutdown', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const lifecycle = new PrismaLifecycle({
      $connect: connect,
      $disconnect: disconnect,
    } as unknown as PrismaService);

    await lifecycle.onModuleInit();
    await lifecycle.onApplicationShutdown();

    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
